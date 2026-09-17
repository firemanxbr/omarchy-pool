//! Publisher-side client for the edge API, with retries.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use pkg_manifest::PackageManifest;
use reqwest::blocking::{Client, Response};
use reqwest::StatusCode;
use serde::Deserialize;

use crate::RepoError;

/// Bodies above this go through the multipart endpoints (Workers caps a
/// single request body; parts stay well under it).
pub const SINGLE_PUT_MAX: u64 = 90 * 1024 * 1024;
pub const PART_SIZE: u64 = 64 * 1024 * 1024;
const ATTEMPTS: u32 = 4;

/// Manifests per request when reading a release (the worker caps at 1000).
const RELEASE_PAGE: u64 = 500;

#[derive(Clone)]
pub struct Api {
    base: String,
    token: String,
    http: Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub id: u64,
    pub ring: String,
    pub seq: u64,
    pub parent_id: Option<u64>,
    pub source_id: Option<u64>,
    pub note: Option<String>,
    pub created_at: String,
}

/// What `POST /api/v1/releases` accepts.
#[derive(Debug, Default, Clone)]
pub struct ReleaseRequest<'a> {
    pub ring: &'a str,
    /// Promote: copy the head selection of this ring.
    pub from_ring: Option<&'a str>,
    /// Roll back / pin: copy this exact release's selection.
    pub from_release_id: Option<u64>,
    pub add: &'a [String],
    /// Names to drop from every source's rows.
    pub remove: &'a [String],
    /// `(source, name)` to drop from that source's rows only: a sync's
    /// removals, which leave another source's build of the name alone.
    pub remove_from: &'a [(String, String)],
    /// Scope `add` lookups and the removals to one repository architecture.
    pub remove_arch: Option<&'a str>,
    /// Promote or roll back this architecture only; the other keeps what the ring serves.
    pub arch: Option<&'a str>,
    pub note: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseCreated {
    pub release: Release,
    pub package_count: u64,
    pub size_download: u64,
    /// Architectures this release serves exactly as its parent did: their
    /// databases are already rendered, the pool carried the artifact rows
    /// over, nothing to render for them.
    #[serde(default)]
    pub unchanged_arches: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryEntry {
    pub id: u64,
    pub seq: u64,
    pub parent_id: Option<u64>,
    pub source_id: Option<u64>,
    pub note: Option<String>,
    pub created_at: String,
    /// Null for a release whose creation failed before its rows were written
    /// (the CPU-limit failures of 2026-09-13 left 22 such rows in edge): a
    /// history must still decode, the gate must still run.
    #[serde(default)]
    pub package_count: Option<u64>,
    pub is_head: u8,
}

/// One dashboard event (`GET /api/v1/events`).
#[derive(Debug, Clone, Deserialize)]
pub struct Event {
    pub id: u64,
    pub kind: String,
    pub ring: Option<String>,
    pub source: Option<String>,
    pub status: String,
    pub summary: String,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    pub duration_ms: Option<u64>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct EventsView {
    events: Vec<Event>,
}

/// The GitHub Actions run this process belongs to, if any.
fn ci_context() -> Option<serde_json::Value> {
    let run_id = std::env::var("GITHUB_RUN_ID").ok()?;
    let server = std::env::var("GITHUB_SERVER_URL").unwrap_or_else(|_| "https://github.com".into());
    let repo = std::env::var("GITHUB_REPOSITORY").unwrap_or_default();
    Some(serde_json::json!({
        "run_id": run_id,
        "run_url": format!("{server}/{repo}/actions/runs/{run_id}"),
        "workflow": std::env::var("GITHUB_WORKFLOW").ok(),
        "job": std::env::var("GITHUB_JOB").ok(),
        "runner_arch": std::env::var("RUNNER_ARCH").ok(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct History {
    pub ring: String,
    pub releases: Vec<HistoryEntry>,
}

/// A manifest as the index returns it (with the provenance it recorded).
#[derive(Debug, Clone, Deserialize)]
pub struct IndexedManifest {
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default = "default_arch")]
    pub repo_arch: String,
    /// The file list, gzip + base64, as `include=files` returns it (inflating
    /// 500 of them per page was too much for the worker); `release()` moves
    /// it into `manifest.files`.
    #[serde(default)]
    pub files_gz: Option<String>,
    #[serde(flatten)]
    pub manifest: PackageManifest,
}

impl IndexedManifest {
    /// Inflates `files_gz` into `manifest.files`.
    fn inflate_files(&mut self) -> Result<(), RepoError> {
        use base64::Engine;
        use std::io::Read;
        let Some(gz) = self.files_gz.take() else {
            return Ok(());
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(gz)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let mut json = String::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut json)?;
        self.manifest.files = serde_json::from_str(&json)?;
        Ok(())
    }
}

fn default_source() -> String {
    "packages".into()
}

fn default_arch() -> String {
    "x86_64".into()
}

#[derive(Debug, Deserialize)]
pub struct ReleaseView {
    pub release: Release,
    pub package_count: u64,
    pub packages: Vec<IndexedManifest>,
    /// `page.next` names the row the next page starts after (keyset
    /// paging); null on the last page.
    #[serde(default)]
    pub page: Option<Page>,
}

#[derive(Debug, Deserialize)]
pub struct Page {
    pub next: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageSummary {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub filename: String,
    pub sha256: String,
    pub size_download: u64,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default = "default_arch")]
    pub repo_arch: String,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseSummaryView {
    pub release: Release,
    pub package_count: u64,
    pub packages: Vec<PackageSummary>,
}

#[derive(Debug, Deserialize)]
struct MultipartCreated {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    uploads: Vec<MultipartUpload>,
}

#[derive(Debug, Deserialize)]
struct MultipartUpload {
    key: String,
    #[serde(rename = "uploadId")]
    upload_id: String,
}

#[derive(Debug, Deserialize)]
struct PartDone {
    #[serde(rename = "partNumber")]
    part_number: u32,
    etag: String,
}

/// What the staging multipart endpoints answer (`/factory/tasks/:id/artifacts/:name/multipart`).
#[derive(Debug, Deserialize)]
struct StagingMultipartCreated {
    upload_id: String,
}

#[derive(Debug, Deserialize)]
struct StagingPartDone {
    part: u32,
    etag: String,
}

/// Retries transient failures (network errors, 429, 5xx) with backoff.
fn with_retry<T>(what: &str, mut f: impl FnMut() -> Result<T, RepoError>) -> Result<T, RepoError> {
    let mut delay = Duration::from_millis(800);
    let mut attempt = 1;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if attempt < ATTEMPTS && is_transient(&e) => {
                tracing::warn!(what, attempt, error = %e, "retrying");
                std::thread::sleep(delay);
                delay *= 2;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_transient(e: &RepoError) -> bool {
    match e {
        RepoError::Http(_) | RepoError::Io(_) => true,
        RepoError::Api { status, .. } => *status == 429 || *status >= 500,
        _ => false,
    }
}

impl Api {
    pub fn new(base: &str, token: &str) -> Result<Self, RepoError> {
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            http: Client::builder()
                .user_agent(concat!("pkg-repo/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(600))
                .build()?,
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v1{path}", self.base)
    }

    fn check(resp: Response) -> Result<Response, RepoError> {
        let status = resp.status();
        if status.is_success() {
            Ok(resp)
        } else {
            let body = resp.text().unwrap_or_default();
            Err(RepoError::Api {
                status: status.as_u16(),
                body,
            })
        }
    }

    /// Whether the index already knows this archive.
    pub fn is_indexed(&self, sha256: &str) -> Result<bool, RepoError> {
        with_retry("is_indexed", || {
            let resp = self
                .http
                .get(self.url(&format!("/packages/{sha256}")))
                .send()?;
            match resp.status() {
                StatusCode::OK => Ok(true),
                StatusCode::NOT_FOUND => Ok(false),
                _ => Self::check(resp).map(|_| false),
            }
        })
    }

    /// Subset of `shas` the index already knows for `arch`.
    pub fn known(&self, shas: &[String], arch: &str) -> Result<Vec<String>, RepoError> {
        Ok(self.known_with_filenames(shas, &[], "", arch)?.0)
    }

    /// Which sha256s are indexed for `arch`, and which of `filenames` already
    /// have an object under `<source>/<arch>/<filename>` (filename → its
    /// sha256): a filename is one object per source, another source's build
    /// of it is another object.
    pub fn known_with_filenames(
        &self,
        shas: &[String],
        filenames: &[String],
        source: &str,
        arch: &str,
    ) -> Result<(Vec<String>, std::collections::HashMap<String, String>), RepoError> {
        #[derive(Deserialize)]
        struct Known {
            known: Vec<String>,
            #[serde(default)]
            by_filename: std::collections::HashMap<String, String>,
        }
        let mut out = Vec::new();
        let mut by_filename = std::collections::HashMap::new();
        let mut i = 0;
        while i < shas.len().max(filenames.len()) {
            let sha_chunk = shas.get(i..(i + 2000).min(shas.len())).unwrap_or(&[]);
            let name_chunk = filenames
                .get(i..(i + 2000).min(filenames.len()))
                .unwrap_or(&[]);
            let k: Known = with_retry("known", || {
                let resp = self
                    .http
                    .post(self.url("/packages/known"))
                    .json(&serde_json::json!({ "sha256": sha_chunk, "filenames": name_chunk, "source": source, "arch": arch }))
                    .send()?;
                Ok(Self::check(resp)?.json()?)
            })?;
            out.extend(k.known);
            by_filename.extend(k.by_filename);
            i += 2000;
        }
        Ok((out, by_filename))
    }

    /// Uploads an archive into the pool under `<source>/<arch>/<filename>`; multipart when large.
    pub fn upload_pool(
        &self,
        sha256: &str,
        filename: &str,
        source: &str,
        arch: &str,
        archive: &Path,
    ) -> Result<(), RepoError> {
        let len = std::fs::metadata(archive)?.len();
        if len <= SINGLE_PUT_MAX {
            return with_retry("upload_pool", || {
                let file = std::fs::File::open(archive)?;
                let resp = self
                    .http
                    .put(self.url(&format!("/pool/{sha256}")))
                    .query(&[("filename", filename), ("source", source), ("arch", arch)])
                    .bearer_auth(&self.token)
                    .header("content-length", len)
                    .body(reqwest::blocking::Body::sized(file, len))
                    .send()?;
                Self::check(resp).map(|_| ())
            });
        }

        let created: MultipartCreated = with_retry("multipart_create", || {
            let resp = self
                .http
                .post(self.url(&format!("/pool/{sha256}/multipart")))
                .query(&[("filename", filename), ("source", source), ("arch", arch)])
                .bearer_auth(&self.token)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })?;
        if created.status.as_deref() == Some("already-present") {
            return Ok(());
        }
        for upload in &created.uploads {
            let mut file = std::fs::File::open(archive)?;
            let mut parts = Vec::new();
            let mut part_number = 1u32;
            let mut buf = vec![
                0u8;
                usize::try_from(PART_SIZE).map_err(|_| RepoError::Api {
                    status: 0,
                    body: "part size does not fit usize".into()
                })?
            ];
            loop {
                let n = read_full(&mut file, &mut buf)?;
                if n == 0 {
                    break;
                }
                let chunk = buf[..n].to_vec();
                let done: PartDone = with_retry("multipart_part", || {
                    let resp = self
                        .http
                        .put(self.url(&format!(
                            "/pool/multipart/{}/part/{part_number}",
                            upload.upload_id
                        )))
                        .query(&[("key", upload.key.as_str())])
                        .bearer_auth(&self.token)
                        .body(chunk.clone())
                        .send()?;
                    Ok(Self::check(resp)?.json()?)
                })?;
                parts
                    .push(serde_json::json!({ "partNumber": done.part_number, "etag": done.etag }));
                part_number += 1;
            }
            with_retry("multipart_complete", || {
                let resp = self
                    .http
                    .post(self.url(&format!("/pool/multipart/{}/complete", upload.upload_id)))
                    .query(&[("key", upload.key.as_str())])
                    .bearer_auth(&self.token)
                    .json(&serde_json::json!({ "parts": parts }))
                    .send()?;
                Self::check(resp).map(|_| ())
            })?;
        }
        Ok(())
    }

    pub fn upload_pool_signature(
        &self,
        sha256: &str,
        filename: &str,
        source: &str,
        arch: &str,
        sig: &Path,
    ) -> Result<(), RepoError> {
        let bytes = std::fs::read(sig)?;
        with_retry("upload_sig", || {
            let resp = self
                .http
                .put(self.url(&format!("/pool/{sha256}/sig")))
                .query(&[("filename", filename), ("source", source), ("arch", arch)])
                .bearer_auth(&self.token)
                .body(bytes.clone())
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    /// Whether the pool signs its own objects (`/status.signing`): when it
    /// does, publishers ask for signatures instead of uploading their own.
    pub fn signing(&self) -> Result<bool, RepoError> {
        let status = self.get_json("/status")?;
        Ok(status["signing"].as_bool().unwrap_or(false))
    }

    /// Asks the pool to sign a package object it stores with its own key.
    pub fn sign_pool(
        &self,
        sha256: &str,
        filename: &str,
        source: &str,
        arch: &str,
    ) -> Result<(), RepoError> {
        with_retry("sign_pool", || {
            let resp = self
                .http
                .post(self.url(&format!("/pool/{sha256}/sign")))
                .query(&[("filename", filename), ("source", source), ("arch", arch)])
                .bearer_auth(&self.token)
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    pub fn index_manifest(
        &self,
        manifest: &PackageManifest,
        source: &str,
        arch: &str,
    ) -> Result<(), RepoError> {
        with_retry("index_manifest", || {
            let resp = self
                .http
                .post(self.url("/packages"))
                .query(&[("source", source), ("arch", arch)])
                .bearer_auth(&self.token)
                .json(manifest)
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    pub fn create_release(&self, req: &ReleaseRequest<'_>) -> Result<ReleaseCreated, RepoError> {
        let body = serde_json::json!({
            "ring": req.ring,
            "from_ring": req.from_ring,
            "from_release_id": req.from_release_id,
            "add": req.add,
            "remove": req.remove,
            "remove_from": req.remove_from.iter().map(|(source, name)| serde_json::json!({"source": source, "name": name})).collect::<Vec<_>>(),
            "remove_arch": req.remove_arch,
            "arch": req.arch,
            "note": req.note,
        });
        with_retry("create_release", || {
            let resp = self
                .http
                .post(self.url("/releases"))
                .bearer_auth(&self.token)
                .json(&body)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    pub fn history(&self, ring: &str) -> Result<History, RepoError> {
        with_retry("history", || {
            let resp = self
                .http
                .get(self.url(&format!("/releases/{ring}/history")))
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// Newest events of one kind (`limit` ≤ 200).
    pub fn events(&self, kind: &str, limit: u32) -> Result<Vec<Event>, RepoError> {
        with_retry("events", || {
            let resp = self
                .http
                .get(self.url("/events"))
                .query(&[("kind", kind), ("limit", &limit.to_string())])
                .send()?;
            Ok(Self::check(resp)?.json::<EventsView>()?.events)
        })
    }

    /// Release view of one architecture with file lists (needed for
    /// `<repo>.files`), fetched in pages of `RELEASE_PAGE` manifests and pinned
    /// to the release the first page returned, so a ring that moves on
    /// mid-render cannot mix two selections.
    pub fn release(&self, ring: &str, arch: &str) -> Result<ReleaseView, RepoError> {
        let mut view: Option<ReleaseView> = None;
        // Keyset paging (page.next → after=): each page is a walk of the
        // index from the previous page's last row, not a sort and a skip.
        let mut after: Option<String> = None;
        // The first page always exists (an empty ring is a 404 from the API).
        loop {
            let mut query = vec![
                ("include", "files".to_owned()),
                ("arch", arch.to_owned()),
                ("limit", RELEASE_PAGE.to_string()),
            ];
            if let Some(a) = &after {
                query.push(("after", a.clone()));
            }
            if let Some(v) = &view {
                query.push(("release_id", v.release.id.to_string()));
            }
            let page: ReleaseView = with_retry("release", || {
                let resp = self
                    .http
                    .get(self.url(&format!("/releases/{ring}")))
                    .query(&query)
                    .send()?;
                Ok(Self::check(resp)?.json()?)
            })?;
            let next = page.page.as_ref().and_then(|p| p.next.clone());
            let mut page = page;
            for p in &mut page.packages {
                p.inflate_files()?;
            }
            match &mut view {
                None => view = Some(page),
                Some(v) => v.packages.extend(page.packages),
            }
            match next {
                Some(n) => after = Some(n),
                None => break,
            }
        }
        view.ok_or_else(|| RepoError::Api {
            status: 0,
            body: "no page returned".into(),
        })
    }

    pub fn release_summary(&self, ring: &str) -> Result<Option<ReleaseSummaryView>, RepoError> {
        with_retry("release_summary", || {
            let resp = self
                .http
                .get(self.url(&format!("/releases/{ring}?fields=summary")))
                .send()?;
            if resp.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            Ok(Some(Self::check(resp)?.json()?))
        })
    }

    /// The summary of one architecture only (`?arch=`).
    pub fn release_summary_arch(
        &self,
        ring: &str,
        arch: &str,
    ) -> Result<Option<ReleaseSummaryView>, RepoError> {
        with_retry("release_summary_arch", || {
            let resp = self
                .http
                .get(self.url(&format!("/releases/{ring}?fields=summary&arch={arch}")))
                .send()?;
            if resp.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            Ok(Some(Self::check(resp)?.json()?))
        })
    }

    pub fn upload_artifact(
        &self,
        release_id: u64,
        kind: &str,
        repo: &str,
        arch: &str,
        bytes: &[u8],
    ) -> Result<(), RepoError> {
        with_retry("upload_artifact", || {
            let resp = self
                .http
                .put(self.url(&format!("/releases/{release_id}/artifacts/{kind}")))
                .query(&[("repo", repo), ("arch", arch)])
                .bearer_auth(&self.token)
                .body(bytes.to_vec())
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    pub fn unreferenced(&self, keep: u32) -> Result<serde_json::Value, RepoError> {
        with_retry("unreferenced", || {
            let resp = self
                .http
                .get(self.url(&format!("/pool/unreferenced?keep={keep}")))
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// One step of the relayout (`phase` copy or purge, routes/relayout.ts): what it moved or deleted, and whether more remains.
    pub fn relayout(&self, phase: &str, limit: u32) -> Result<serde_json::Value, RepoError> {
        with_retry("relayout", || {
            let resp = self
                .http
                .post(self.url(&format!("/pool/relayout?phase={phase}&limit={limit}")))
                .bearer_auth(&self.token)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    pub fn gc(&self, keep: u32, limit: u32) -> Result<serde_json::Value, RepoError> {
        with_retry("gc", || {
            let resp = self
                .http
                .post(self.url(&format!("/pool/gc?keep={keep}&limit={limit}")))
                .bearer_auth(&self.token)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `GET` any JSON endpoint, retrying on 5xx.
    pub fn get_json(&self, path: &str) -> Result<serde_json::Value, RepoError> {
        with_retry("get_json", || {
            let resp = self.http.get(self.url(path)).send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `GET` a JSON document from any URL (a public feed), retrying on 5xx.
    pub fn get_external_json(&self, url: &str) -> Result<serde_json::Value, RepoError> {
        self.get_external_json_as(url, None)
    }

    /// The same with a bearer token of the caller's (GitHub's API: 60 requests an hour without one).
    pub fn get_external_json_as(
        &self,
        url: &str,
        bearer: Option<&str>,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("get_external_json", || {
            let mut req = self.http.get(url);
            if let Some(t) = bearer.filter(|t| !t.is_empty()) {
                req = req.bearer_auth(t);
            }
            let resp = req.send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `POST` JSON to any URL (a public API), retrying on 5xx.
    pub fn post_external_json(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("post_external_json", || {
            let resp = self.http.post(url).json(body).send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `PUT` raw bytes to an authenticated endpoint (a staging artifact), retrying on 5xx.
    pub fn put_bytes(&self, path: &str, bytes: &[u8]) -> Result<(), RepoError> {
        with_retry("put_bytes", || {
            let resp = self
                .http
                .put(self.url(path))
                .bearer_auth(&self.token)
                .body(bytes.to_vec())
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    /// A file into a task's staging workspace: one `PUT` up to
    /// `SINGLE_PUT_MAX`, the staging multipart endpoints above it — the way
    /// the community worker's `upload_staging` does. The edge refuses a
    /// single body above 100 MB before the pool sees it (2026-09-17,
    /// bitwarden's 144 MB review build: three attempts into a 413).
    pub fn stage_file(&self, task: u64, name: &str, file: &Path) -> Result<(), RepoError> {
        self.stage_file_sized(task, name, file, SINGLE_PUT_MAX, PART_SIZE)
    }

    /// `stage_file` with the two sizes as arguments (the test sends bytes, not megabytes).
    fn stage_file_sized(
        &self,
        task: u64,
        name: &str,
        file: &Path,
        single_max: u64,
        part_size: u64,
    ) -> Result<(), RepoError> {
        let len = std::fs::metadata(file)?.len();
        let path = format!("/factory/tasks/{task}/artifacts/{name}");
        if len <= single_max {
            return with_retry("stage_file", || {
                let f = std::fs::File::open(file)?;
                let resp = self
                    .http
                    .put(self.url(&path))
                    .timeout(upload_timeout(len))
                    .bearer_auth(&self.token)
                    .header("content-type", "application/octet-stream")
                    .header("content-length", len)
                    .body(reqwest::blocking::Body::sized(f, len))
                    .send()?;
                Self::check(resp).map(|_| ())
            });
        }
        let base = self.url(&format!("{path}/multipart"));
        let created: StagingMultipartCreated = with_retry("staging_multipart_create", || {
            let resp = self
                .http
                .post(&base)
                .query(&[("action", "create")])
                .bearer_auth(&self.token)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })?;
        let upload_id = created.upload_id.as_str();
        // The parts, then the complete — and whatever fails after the
        // create, the upload is abandoned, so the bucket keeps no half of a
        // package nobody completes.
        let uploaded = (|| -> Result<(), RepoError> {
            let mut f = std::fs::File::open(file)?;
            let mut parts = Vec::new();
            let mut part_number = 1u32;
            let mut buf = vec![
                0u8;
                usize::try_from(part_size).map_err(|_| RepoError::Api {
                    status: 0,
                    body: "part size does not fit usize".into()
                })?
            ];
            loop {
                let n = read_full(&mut f, &mut buf)?;
                if n == 0 {
                    break;
                }
                let chunk = buf[..n].to_vec();
                let part = part_number.to_string();
                let done: StagingPartDone = with_retry("staging_multipart_part", || {
                    let resp = self
                        .http
                        .post(&base)
                        .query(&[
                            ("action", "part"),
                            ("part", &part),
                            ("upload_id", upload_id),
                        ])
                        .timeout(upload_timeout(n as u64))
                        .bearer_auth(&self.token)
                        .body(chunk.clone())
                        .send()?;
                    Ok(Self::check(resp)?.json()?)
                })?;
                parts.push(serde_json::json!({ "partNumber": done.part, "etag": done.etag }));
                part_number += 1;
            }
            with_retry("staging_multipart_complete", || {
                let resp = self
                    .http
                    .post(&base)
                    .query(&[("action", "complete"), ("upload_id", upload_id)])
                    .bearer_auth(&self.token)
                    .json(&serde_json::json!({ "parts": parts }))
                    .send()?;
                Self::check(resp).map(|_| ())
            })
        })();
        if uploaded.is_err() {
            let _ = self
                .http
                .post(&base)
                .query(&[("action", "abort"), ("upload_id", upload_id)])
                .bearer_auth(&self.token)
                .send();
        }
        uploaded
    }

    /// `PUT` a JSON body to an authenticated endpoint, retrying on 5xx.
    pub fn put_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("put_json", || {
            let resp = self
                .http
                .put(self.url(path))
                .bearer_auth(&self.token)
                .json(body)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `PATCH` a JSON body to an authenticated endpoint, retrying on 5xx.
    pub fn patch_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("patch_json", || {
            let resp = self
                .http
                .patch(self.url(path))
                .bearer_auth(&self.token)
                .json(body)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `POST` a JSON body to an authenticated endpoint, retrying on 5xx.
    pub fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("post_json", || {
            let resp = self
                .http
                .post(self.url(path))
                .bearer_auth(&self.token)
                .json(body)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `POST` with a bearer token of the caller's choosing (a worker token to
    /// claim, a job token for everything else); `None` on 204.
    pub fn post_json_as(
        &self,
        token: &str,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, RepoError> {
        with_retry("post_json_as", || {
            let resp = self
                .http
                .post(self.url(path))
                .bearer_auth(token)
                .json(body)
                .send()?;
            let resp = Self::check(resp)?;
            if resp.status().as_u16() == 204 {
                return Ok(None);
            }
            Ok(Some(resp.json()?))
        })
    }

    /// Records a dashboard event. Under GitHub Actions the payload gains a
    /// `ci` object (run id and URL, job, runner architecture) so the dashboard
    /// can link every line of activity to the run that produced it.
    pub fn post_event(&self, event: &serde_json::Value) -> Result<(), RepoError> {
        let mut event = event.clone();
        if let Some(ci) = ci_context() {
            let payload = event
                .as_object_mut()
                .map(|o| o.entry("payload").or_insert_with(|| serde_json::json!({})));
            if let Some(serde_json::Value::Object(p)) = payload {
                p.insert("ci".into(), ci);
            } else if let Some(p) = payload {
                if p.is_null() {
                    *p = serde_json::json!({ "ci": ci });
                }
            }
        }
        with_retry("post_event", || {
            let resp = self
                .http
                .post(self.url("/events"))
                .bearer_auth(&self.token)
                .json(&event)
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    /// Streams `url` to `dest`, returning the SHA-256 of what was written.
    pub fn download(&self, url: &str, dest: &Path) -> Result<String, RepoError> {
        self.download_with(url, dest, false)
    }

    /// The same, with this client's token: what only a maintainer or this
    /// job may read (a package in staging, for the publish job).
    pub fn download_as_self(&self, url: &str, dest: &Path) -> Result<String, RepoError> {
        self.download_with(url, dest, true)
    }

    fn download_with(&self, url: &str, dest: &Path, authed: bool) -> Result<String, RepoError> {
        use sha2::{Digest, Sha256};
        with_retry("download", || {
            let req = self.http.get(url);
            let req = if authed {
                req.bearer_auth(&self.token)
            } else {
                req
            };
            let mut resp = Self::check(req.send()?)?;
            let mut file = std::fs::File::create(dest)?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 1024 * 1024];
            loop {
                let n = resp.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                std::io::Write::write_all(&mut file, &buf[..n])?;
            }
            Ok(hex::encode(hasher.finalize()))
        })
    }
}

/// How long one upload request may take: the client's ten minutes would
/// cut a 64 MB part on a link under 110 KB/s and retry it three times
/// more, forty minutes into a certain failure. Two minutes plus what the
/// body needs at 50 KB/s — a slow home uplink finishes, a dead one is
/// noticed within the hour.
fn upload_timeout(len: u64) -> Duration {
    Duration::from_secs(120 + len / (50 * 1024))
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = r.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// One request as the test server saw it: method, path with query, body.
    #[derive(Debug, Clone)]
    struct Seen {
        method: String,
        target: String,
        body: Vec<u8>,
    }

    /// A one-thread HTTP/1.1 server that records every request and answers
    /// what the staging endpoints answer. `fail_part` makes that part answer
    /// `fail_status` on every attempt; `fail_complete` does the same to the
    /// complete.
    fn staging_server(
        fail_part: Option<u32>,
        fail_complete: bool,
        fail_status: &'static str,
    ) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    continue;
                }
                let mut words = line.split_whitespace();
                let method = words.next().unwrap_or_default().to_owned();
                let target = words.next().unwrap_or_default().to_owned();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0u8; len];
                std::io::Read::read_exact(&mut reader, &mut body).unwrap();
                let part = target
                    .split('&')
                    .find_map(|q| q.strip_prefix("part="))
                    .and_then(|p| p.parse::<u32>().ok());
                let (status, answer) = if target.contains("action=create") {
                    ("201 Created", r#"{"upload_id":"u1","key":"k"}"#.to_owned())
                } else if target.contains("action=part") {
                    if part == fail_part {
                        (fail_status, r#"{"error":"no"}"#.to_owned())
                    } else {
                        (
                            "200 OK",
                            format!(
                                r#"{{"part":{},"etag":"e{}"}}"#,
                                part.unwrap(),
                                part.unwrap()
                            ),
                        )
                    }
                } else if target.contains("action=complete") && fail_complete {
                    (fail_status, r#"{"error":"no"}"#.to_owned())
                } else if target.contains("action=complete") || target.contains("action=abort") {
                    ("200 OK", r#"{"key":"k","size":0}"#.to_owned())
                } else {
                    ("201 Created", r#"{"key":"k","size":0}"#.to_owned())
                };
                log.lock().unwrap().push(Seen {
                    method,
                    target,
                    body,
                });
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                    answer.len()
                )
                .unwrap();
                stream.flush().unwrap();
            }
        });
        (base, seen)
    }

    fn file_of(bytes: &[u8]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        f
    }

    #[test]
    fn a_small_artifact_is_one_put() {
        let (base, seen) = staging_server(None, false, "500 Internal Server Error");
        let api = Api::new(&base, "t").unwrap();
        let f = file_of(b"0123456789");
        api.stage_file_sized(7, "a.pkg.tar.zst", f.path(), 10, 4)
            .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, "PUT");
        assert_eq!(
            seen[0].target,
            "/api/v1/factory/tasks/7/artifacts/a.pkg.tar.zst"
        );
        assert_eq!(seen[0].body, b"0123456789");
    }

    #[test]
    fn a_large_artifact_goes_in_parts_and_completes() {
        let (base, seen) = staging_server(None, false, "500 Internal Server Error");
        let api = Api::new(&base, "t").unwrap();
        let f = file_of(b"0123456789A");
        api.stage_file_sized(7, "big.pkg.tar.zst", f.path(), 10, 4)
            .unwrap();
        let seen = seen.lock().unwrap();
        let targets: Vec<&str> = seen.iter().map(|s| s.target.as_str()).collect();
        assert_eq!(
            targets,
            [
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=create",
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=part&part=1&upload_id=u1",
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=part&part=2&upload_id=u1",
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=part&part=3&upload_id=u1",
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=complete&upload_id=u1",
            ]
        );
        assert!(seen.iter().all(|s| s.method == "POST"));
        assert_eq!(seen[1].body, b"0123");
        assert_eq!(seen[2].body, b"4567");
        assert_eq!(seen[3].body, b"89A");
        let complete: serde_json::Value = serde_json::from_slice(&seen[4].body).unwrap();
        assert_eq!(
            complete,
            serde_json::json!({ "parts": [
                { "partNumber": 1, "etag": "e1" }, { "partNumber": 2, "etag": "e2" }, { "partNumber": 3, "etag": "e3" }
            ] })
        );
    }

    /// A refusal the pool means (the lease is not yours): no retry, the
    /// upload is abandoned at once.
    #[test]
    fn a_part_that_will_not_go_aborts_the_upload() {
        let (base, seen) = staging_server(Some(2), false, "409 Conflict");
        let api = Api::new(&base, "t").unwrap();
        let f = file_of(b"0123456789A");
        let err = api
            .stage_file_sized(7, "big.pkg.tar.zst", f.path(), 10, 4)
            .unwrap_err();
        assert!(matches!(err, RepoError::Api { status: 409, .. }), "{err}");
        let seen = seen.lock().unwrap();
        let targets: Vec<&str> = seen.iter().map(|s| s.target.as_str()).collect();
        assert_eq!(
            targets,
            [
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=create",
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=part&part=1&upload_id=u1",
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=part&part=2&upload_id=u1",
                "/api/v1/factory/tasks/7/artifacts/big.pkg.tar.zst/multipart?action=abort&upload_id=u1",
            ]
        );
    }

    /// A pool that keeps answering 500: the part is retried `ATTEMPTS`
    /// times (with the backoff — this is the slow test), then the abort.
    #[test]
    fn a_part_the_pool_cannot_take_is_retried_then_aborted() {
        let (base, seen) = staging_server(Some(2), false, "500 Internal Server Error");
        let api = Api::new(&base, "t").unwrap();
        let f = file_of(b"0123456789A");
        let err = api
            .stage_file_sized(7, "big.pkg.tar.zst", f.path(), 10, 4)
            .unwrap_err();
        assert!(matches!(err, RepoError::Api { status: 500, .. }), "{err}");
        let seen = seen.lock().unwrap();
        let tries = seen.iter().filter(|s| s.target.contains("part=2&")).count();
        assert_eq!(tries, ATTEMPTS as usize);
        assert_eq!(seen.len(), 3 + ATTEMPTS as usize);
        assert!(seen
            .last()
            .unwrap()
            .target
            .ends_with("action=abort&upload_id=u1"));
        assert!(!seen.iter().any(|s| s.target.contains("action=complete")));
    }

    /// The complete refused: the same abort — no half of a package stays.
    #[test]
    fn a_complete_that_will_not_go_aborts_the_upload() {
        let (base, seen) = staging_server(None, true, "409 Conflict");
        let api = Api::new(&base, "t").unwrap();
        let f = file_of(b"0123456789A");
        let err = api
            .stage_file_sized(7, "big.pkg.tar.zst", f.path(), 10, 4)
            .unwrap_err();
        assert!(matches!(err, RepoError::Api { status: 409, .. }), "{err}");
        let seen = seen.lock().unwrap();
        let targets: Vec<&str> = seen.iter().map(|s| s.target.as_str()).collect();
        assert_eq!(targets.len(), 6);
        assert!(targets[4].ends_with("action=complete&upload_id=u1"));
        assert!(targets[5].ends_with("action=abort&upload_id=u1"));
    }

    #[test]
    fn an_upload_gets_the_time_its_body_needs() {
        assert_eq!(upload_timeout(0), Duration::from_secs(120));
        assert_eq!(
            upload_timeout(PART_SIZE),
            Duration::from_secs(120 + 64 * 1024 / 50)
        );
    }
}
