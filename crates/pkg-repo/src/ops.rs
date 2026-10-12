//! The operations behind the CLI commands — and behind `pkg-repo work`, the
//! worker that pulls the same operations as jobs from the pool. Each takes an
//! `Api` (whose bearer token is a maintainer's on the command line, or a
//! per-job token on a worker) and reports to the journal.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};
use pkg_manifest::PackageManifest;

use crate::client::{Api, ReleaseRequest};
use crate::sync::SyncOptions;
use crate::{sign, sync, DatabaseWriter, Flavor, RepoError};

pub fn record_event(api: &Api, event: &serde_json::Value, payload: Option<&str>) -> Result<()> {
    let mut event = event.clone();
    let payload: Option<serde_json::Value> = payload
        .map(serde_json::from_str)
        .transpose()
        .context("--payload must be JSON")?;
    event["payload"] = payload.unwrap_or(serde_json::Value::Null);
    api.post_event(&event)?;
    Ok(())
}

/// The release a ring serves now, if any.
pub fn head(api: &Api, ring: &str) -> Result<Option<u64>> {
    Ok(api
        .history(ring)?
        .releases
        .iter()
        .find(|r| r.is_head != 0)
        .map(|r| r.id))
}

/// The sync with the pipeline's failure rule applied; the report for callers that render after it.
pub fn run_sync_report(api: &Api, opts: &SyncOptions) -> Result<sync::SyncReport> {
    let report = sync::run(api, opts)?;
    if !report.failed.is_empty() && report.uploaded == 0 && report.already_indexed == 0 {
        anyhow::bail!(
            "{} package(s) failed to import and none of this source is indexed",
            report.failed.len()
        );
    }
    Ok(report)
}

pub fn run_sync(api: &Api, opts: &SyncOptions) -> Result<()> {
    let report = sync::run(api, opts)?;
    println!(
        "upstream {} · already indexed {} · uploaded {} ({}) · failed {} · removed {} · deferred {}",
        report.upstream_total,
        report.already_indexed,
        report.uploaded,
        sync::human(report.bytes_uploaded),
        report.failed.len(),
        report.removed,
        report.deferred
    );
    if report.yielded > 0 {
        println!(
            "yielded {} package(s) to {}",
            report.yielded,
            opts.defer_to.join(", ")
        );
    }
    if let Some((id, seq)) = report.release {
        println!("release id {id} (#{seq})");
    }
    for (file, err) in &report.failed {
        eprintln!("FAILED {file}: {err}");
    }
    // A package upstream serves broken (bad signature, missing file) is left
    // out and reported as a warning in the journal; it must not fail the run
    // — the release without it is still correct, and a promotion that aligns
    // the OPR channel must not be undone because one package was refused.
    // Only a sync where nothing at all is served — every import failed and
    // the index had none of the upstream before — is an error; an unchanged
    // selection with one refused package is the normal hourly case.
    if !report.failed.is_empty() && report.uploaded == 0 && report.already_indexed == 0 {
        anyhow::bail!(
            "{} package(s) failed to import and none of this source is indexed",
            report.failed.len()
        );
    }
    if !report.failed.is_empty() {
        eprintln!(
            "warning: {} package(s) left out (see the journal); the release is without them",
            report.failed.len()
        );
    }
    Ok(())
}

pub fn publish(
    api: &Api,
    ring: &str,
    source: &str,
    arch: &str,
    note: Option<&str>,
    archives: &[PathBuf],
) -> Result<()> {
    let started = Instant::now();
    // The pool's own key signs what it stores when it has one; a local .sig
    // is the transition path for publishers running against an older pool.
    let pool_signs = api.signing()?;
    let mut added = Vec::new();
    let mut bytes = 0u64;
    for archive in archives {
        let manifest = pkg_extract::extract_manifest(archive)
            .with_context(|| format!("inspecting {}", archive.display()))?;
        let sha = manifest.sha256.clone();
        // The pool keeps the first object a source stored under a filename
        // (the same rule the sync applies to upstream rebuilds): a rebuild of
        // the same version pins what is already there instead of failing on
        // the size/sha mismatch.
        let (_, by_filename) =
            api.known_with_filenames(&[], std::slice::from_ref(&manifest.filename), source, arch)?;
        let sha = match by_filename.get(&manifest.filename) {
            Some(stored) if *stored != sha => {
                eprintln!(
                    "{} {} already in pool under {} with different content; pinning the stored object",
                    manifest.name, manifest.version, manifest.filename
                );
                stored.clone()
            }
            _ => sha,
        };
        if api.is_indexed(&sha)? {
            eprintln!(
                "{} {} already in pool, skipping upload",
                manifest.name, manifest.version
            );
        } else {
            eprintln!(
                "uploading {} {} ({} bytes)",
                manifest.name, manifest.version, manifest.size_download
            );
            api.upload_pool(&sha, &manifest.filename, source, arch, archive)?;
            let sig = PathBuf::from(format!("{}.sig", archive.display()));
            if pool_signs {
                api.sign_pool(&sha, &manifest.filename, source, arch)?;
            } else if sig.exists() {
                api.upload_pool_signature(&sha, &manifest.filename, source, arch, &sig)?;
            }
            api.index_manifest(&manifest, source, arch)?;
            bytes += manifest.size_download;
        }
        added.push(sha);
    }
    let created = api.create_release(&ReleaseRequest {
        ring,
        add: &added,
        remove_arch: Some(arch),
        note,
        ..ReleaseRequest::default()
    })?;
    println!(
        "release {}#{} (id {}) — {} packages, {} bytes in pool",
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.package_count,
        created.size_download
    );
    api.post_event(&serde_json::json!({
        "kind": "publish", "ring": ring, "source": source, "status": "ok",
        "summary": format!("{} archive(s) published ({}) → {}#{}", archives.len(), sync::human(bytes), ring, created.release.seq),
        "duration_ms": millis(started.elapsed()),
        "payload": { "release_id": created.release.id, "sha256": added },
    }))?;
    Ok(())
}

/// Promotes `from` into `to`: the whole selection, or one architecture
/// (`arch`) while the other keeps what `to` serves today.
pub fn promote(
    api: &Api,
    from: &str,
    to: &str,
    note: Option<&str>,
    arch: Option<&str>,
) -> Result<u64> {
    let started = Instant::now();
    let created = api.create_release(&ReleaseRequest {
        ring: to,
        from_ring: Some(from),
        note,
        arch,
        ..ReleaseRequest::default()
    })?;
    let took = started.elapsed();
    println!(
        "promoted {from}{} → {}#{} (id {}, from release {:?}) — {} packages, {} bytes, {:?}, zero bytes copied",
        arch.map(|a| format!(" ({a} only)")).unwrap_or_default(),
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.release.source_id,
        created.package_count,
        created.size_download,
        took
    );
    api.post_event(&serde_json::json!({
        "kind": "promote", "ring": to, "source": arch, "status": "ok",
        "summary": format!("{from} → {to}#{}{}: {} packages ({}), zero bytes copied", created.release.seq, arch.map(|a| format!(" ({a} only)")).unwrap_or_default(), created.package_count, sync::human(created.size_download)),
        "duration_ms": millis(took),
        "payload": { "release_id": created.release.id, "from_release_id": created.release.source_id, "note": note, "arch": arch },
    }))?;
    Ok(created.release.id)
}

/// Points `ring` at the selection of release `to` — all of it, or one
/// architecture (`arch`) while the other keeps what the ring serves today.
pub fn rollback(
    api: &Api,
    ring: &str,
    to: u64,
    note: Option<&str>,
    arch: Option<&str>,
) -> Result<u64> {
    let started = Instant::now();
    let created = api.create_release(&ReleaseRequest {
        ring,
        from_release_id: Some(to),
        note,
        arch,
        ..ReleaseRequest::default()
    })?;
    let took = started.elapsed();
    println!(
        "{ring} now serves the selection of release {to} as {}#{} (id {}) — {} packages, {:?}, zero bytes copied",
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.package_count,
        took
    );
    api.post_event(&serde_json::json!({
        "kind": "rollback", "ring": ring, "source": arch, "status": "warn",
        "summary": format!("{ring}{} rolled back to release {to} as #{} ({} packages)", arch.map(|a| format!(" ({a} only)")).unwrap_or_default(), created.release.seq, created.package_count),
        "duration_ms": millis(took),
        "payload": { "release_id": created.release.id, "to_release_id": to, "note": note, "arch": arch },
    }))?;
    Ok(created.release.id)
}

pub fn releases(api: &Api, rings: &[String], json: bool) -> Result<()> {
    if json {
        // The API's rows as they are, so scripts and agents read release
        // state without scraping the table below.
        let mut out = serde_json::Map::new();
        for ring in rings {
            out.insert(
                ring.clone(),
                api.get_json(&format!("/releases/{ring}/history"))?,
            );
        }
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    for ring in rings {
        let history = api.history(ring)?;
        if rings.len() > 1 {
            println!("[{ring}]");
        }
        println!(
            "{:<6} {:<5} {:<9} {:<8} {:<7} {:<26} note",
            "id", "seq", "packages", "source", "head", "created"
        );
        for r in &history.releases {
            println!(
                "{:<6} {:<5} {:<9} {:<8} {:<7} {:<26} {}",
                r.id,
                r.seq,
                r.package_count.map_or("?".to_owned(), |n| n.to_string()),
                r.source_id.map_or("-".to_owned(), |s| s.to_string()),
                if r.is_head == 1 { "*" } else { "" },
                r.created_at,
                r.note.as_deref().unwrap_or("")
            );
        }
    }
    Ok(())
}

/// What changed between two releases of a ring (`GET /releases/:ring/diff`).
pub fn diff(
    api: &Api,
    ring: &str,
    from: Option<u64>,
    to: Option<u64>,
    arch: Option<&str>,
    json: bool,
) -> Result<()> {
    let mut q = Vec::new();
    if let Some(f) = from {
        q.push(format!("from={f}"));
    }
    if let Some(t) = to {
        q.push(format!("to={t}"));
    }
    if let Some(a) = arch {
        q.push(format!("arch={a}"));
    }
    let d = api.get_json(&format!("/releases/{ring}/diff?{}", q.join("&")))?;
    if json {
        println!("{}", serde_json::to_string_pretty(&d)?);
        return Ok(());
    }
    let id = |side: &str| {
        d.get(side)
            .and_then(|s| s.get("id"))
            .and_then(serde_json::Value::as_u64)
            .map_or("-".to_owned(), |i| i.to_string())
    };
    let n = |k: &str| {
        d.get("counts")
            .and_then(|c| c.get(k))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    };
    println!(
        "{ring}: release {} → {}: +{} −{} ↑{} ({} → {} packages)",
        id("from"),
        id("to"),
        n("added"),
        n("removed"),
        n("upgraded"),
        n("before"),
        n("after")
    );
    let list = |k: &str| {
        d.get(k)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };
    for p in list("added") {
        println!(
            "+ {} {} ({})",
            p["name"].as_str().unwrap_or(""),
            p["version"].as_str().unwrap_or(""),
            p["arch"].as_str().unwrap_or("")
        );
    }
    for p in list("removed") {
        println!(
            "- {} {} ({})",
            p["name"].as_str().unwrap_or(""),
            p["version"].as_str().unwrap_or(""),
            p["arch"].as_str().unwrap_or("")
        );
    }
    for p in list("upgraded") {
        println!(
            "↑ {} {} → {} ({})",
            p["name"].as_str().unwrap_or(""),
            p["from"].as_str().unwrap_or(""),
            p["to"].as_str().unwrap_or(""),
            p["arch"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

/// Renders the ring's databases for one architecture — one `db` and one
/// `files` per source the release serves there — and uploads them to the
/// release; returns the repositories written.
///
/// The pool signs the databases as it stores them when it holds the key;
/// `key` (a local `GnuPG` key id) only signs against a pool without one.
///
/// The release is read a page at a time (`Api::release_pages`) and each
/// package is written into its source's two databases as it comes, in files
/// under the process's temporary directory, so the render holds one page and
/// one package's file list, never the ring (#319): edge's `x86_64` lists 18 M
/// paths, 1.3 GB of them, which held whole died at a pool job's 2 GB memory
/// limit every time (release 1076, 2026-10-12). The pages come in name order
/// within a source, the order [`sorted`] gives: the bytes are the ones the
/// whole-release render made. Nothing is uploaded before the last page is
/// read; once every database is up, the pool is told the render is whole
/// (`Api::rendered`).
pub fn render(api: &Api, ring: &str, arch: &str, key: Option<&str>) -> Result<Vec<String>> {
    // Its own directory: two renders in one process (a test's) never share one.
    static RENDERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let started = Instant::now();
    let pool_signs = api.signing()?;
    let key = if pool_signs { None } else { key };
    let n = RENDERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = tempfile_dir()?.join(format!("render-{ring}-{arch}-{n}"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let rendered = render_in(api, ring, arch, key, &tmp);
    let _ = std::fs::remove_dir_all(&tmp);
    // The process's own directory goes with its last render, as it did before.
    if let Some(parent) = tmp.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    let (release, rendered) = rendered?;

    let took = started.elapsed();
    println!(
        "rendered {ring}#{} (id {}) for {arch}: {}",
        release.seq,
        release.id,
        rendered
            .iter()
            .map(|(r, n)| format!("{r} ({n})"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    api.post_event(&serde_json::json!({
        "kind": "render", "ring": ring, "status": "ok",
        "summary": format!("{ring}#{}: {} database(s) rendered{}", release.seq, rendered.len(), if pool_signs || key.is_some() { ", signed" } else { "" }),
        "duration_ms": millis(took),
        "payload": { "release_id": release.id, "repos": rendered.iter().map(|(r, n)| serde_json::json!({"repo": r, "packages": n})).collect::<Vec<_>>() },
    }))?;
    Ok(rendered.into_iter().map(|(r, _)| r).collect())
}

/// One source's two databases, written as the release's pages come.
struct SourceDbs {
    db: DatabaseWriter<std::io::BufWriter<std::fs::File>>,
    files: DatabaseWriter<std::io::BufWriter<std::fs::File>>,
    /// The last name written: a page out of name order (or a name twice) is refused.
    last: Option<String>,
}

impl SourceDbs {
    fn create(dir: &std::path::Path, repo: &str) -> Result<Self, RepoError> {
        let open = |kind: &str| -> Result<_, RepoError> {
            Ok(std::io::BufWriter::new(std::fs::File::create(
                dir.join(format!("{repo}.{kind}")),
            )?))
        };
        Ok(Self {
            db: DatabaseWriter::new(open("db")?, Flavor::Db),
            files: DatabaseWriter::new(open("files")?, Flavor::Files),
            last: None,
        })
    }
}

/// The render's work in `tmp`: every page into its source's databases, then each database
/// uploaded from its file (and signed with `key` when the pool does not sign), then the pool
/// told. The release, and each repository with its package count.
fn render_in(
    api: &Api,
    ring: &str,
    arch: &str,
    key: Option<&str>,
    tmp: &std::path::Path,
) -> Result<(crate::client::Release, Vec<(String, usize)>)> {
    let mut by_source: BTreeMap<String, SourceDbs> = BTreeMap::new();
    let release = api.release_pages(ring, arch, |_, page| {
        for mut p in page {
            p.inflate_files()?;
            let dbs = match by_source.entry(p.source.clone()) {
                std::collections::btree_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::btree_map::Entry::Vacant(e) => {
                    let repo = format!("omarchy-{}-{ring}", e.key());
                    e.insert(SourceDbs::create(tmp, &repo)?)
                }
            };
            if dbs.last.as_ref().is_some_and(|l| *l >= p.manifest.name) {
                return Err(RepoError::Source(format!(
                    "render: {} of {} came after {}: the pool's pages are not in name order",
                    p.manifest.name,
                    p.source,
                    dbs.last.as_deref().unwrap_or_default()
                )));
            }
            dbs.db.append(&p.manifest)?;
            dbs.files.append(&p.manifest)?;
            dbs.last = Some(std::mem::take(&mut p.manifest.name));
        }
        Ok(())
    })?;

    let mut rendered = Vec::new();
    for (source, dbs) in by_source {
        let repo = format!("omarchy-{source}-{ring}");
        let packages = dbs.db.count();
        for (kind, writer) in [("db", dbs.db), ("files", dbs.files)] {
            writer
                .finish()?
                .into_inner()
                .map_err(std::io::IntoInnerError::into_error)?;
            let file = tmp.join(format!("{repo}.{kind}"));
            api.upload_artifact_file(release.id, kind, &repo, arch, &file)?;
            if let Some(key) = key {
                let sig = sign::detach_sign(&file, key)?;
                api.upload_artifact(
                    release.id,
                    &format!("{kind}.sig"),
                    &repo,
                    arch,
                    &std::fs::read(&sig)?,
                )?;
            }
            eprintln!(
                "uploaded {repo}.{kind} ({packages} packages, {} bytes)",
                std::fs::metadata(&file)?.len()
            );
        }
        rendered.push((repo, packages));
    }
    // Every database of `arch` is up: what the release carried for it and did not get again goes.
    if !api.rendered(release.id, arch)? {
        eprintln!(
            "{ring}/{arch}: the pool keeps no carried databases (an older pool): nothing to drop"
        );
    }
    Ok((release, rendered))
}

pub fn gc(api: &Api, keep: u32, delete: bool) -> Result<()> {
    let started = Instant::now();
    let report = api.unreferenced(keep)?;
    let count = report["count"].as_u64().unwrap_or(0);
    let bytes = report["bytes"].as_u64().unwrap_or(0);
    println!(
        "{count} unreferenced package(s), {} (keeping the last {keep} releases per ring)",
        sync::human(bytes)
    );
    if !delete {
        return Ok(());
    }
    let mut deleted = 0u64;
    let mut freed = 0u64;
    loop {
        let r = api.gc(keep, 200)?;
        deleted += r["deleted"].as_u64().unwrap_or(0);
        freed += r["bytes"].as_u64().unwrap_or(0);
        if r["remaining"].as_u64().unwrap_or(0) == 0 || r["deleted"].as_u64().unwrap_or(0) == 0 {
            break;
        }
    }
    println!("deleted {deleted} package(s), freed {}", sync::human(freed));
    api.post_event(&serde_json::json!({
        "kind": "gc", "status": "ok",
        "summary": format!("retention: deleted {deleted} unreferenced package(s), freed {}", sync::human(freed)),
        "duration_ms": millis(started.elapsed()),
        "payload": { "keep": keep, "deleted": deleted, "bytes": freed },
    }))?;
    Ok(())
}

pub fn sorted(mut packages: Vec<PackageManifest>) -> Vec<PackageManifest> {
    packages.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.version.cmp(&b.version)));
    packages
}

pub fn millis(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

pub fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("pkg-repo-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
