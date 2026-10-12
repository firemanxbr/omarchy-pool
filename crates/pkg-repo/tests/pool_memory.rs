//! A pool job's memory, by design (#319): a sync's imports and a ring's render fit a data rlimit
//! whatever the packages' sizes and the ring's file lists. On the Studio canary every `x86_64` sync
//! died at its 2 GB (2026-10-09 to 12): four chaotic kernels imported at once, each upload holding
//! three copies of a 64 MB part, and the render holding edge's whole `x86_64` release — 18 M paths.
//!
//! A pool and an upstream on a local port (`serve`) answer what the real ones do. The render's
//! databases, read a page at a time, are the bytes `build_database` makes of the whole release.
//! On Linux the built `pkg-repo` runs under `ulimit -d` — the kernel counts every private writable
//! mapping against it, as it counts a pool job's 2 GB — with the dispatcher's `MALLOC_ARENA_MAX`:
//! large packages through the sync and a large ring through the render, every byte arriving. The
//! `pkg-repo` of the release before this one fails both, as the canary did: the render with
//! `I/O error: out of memory` (171 MB of data at its peak without one), the sync with `memory
//! allocation of 67108864 bytes failed` and SIGABRT (794 MB); this one peaks at 11 MB and 119 MB.

mod mock_pool;

use std::collections::BTreeMap;
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pkg_manifest::PackageManifest;
use pkg_repo::client::Api;
use pkg_repo::{build_database, Flavor};
use serde_json::{json, Value};

use mock_pool::{answer, serve, Answer, Head};

fn release_row(id: u64) -> Value {
    json!({ "id": id, "ring": "edge", "seq": 650, "parent_id": null, "source_id": null, "note": null, "created_at": "2026-10-12T11:54:17Z" })
}

// ---------- the render ----------

/// A package with its file list, as the pool's index holds it.
fn manifest(name: &str, files: &[String]) -> PackageManifest {
    serde_json::from_value(json!({
        "schema_version": 2, "name": name, "version": "1.0-1", "arch": "x86_64",
        "description": format!("{name} for tests"), "size_installed": 3, "size_download": 1,
        "sha256": format!("{:0>64}", name.len()), "filename": format!("{name}-1.0-1-x86_64.pkg.tar.zst"),
        "pkginfo": { "base": name, "builddate": 1 }, "provides": [format!("{name}=1.0-1")], "requires": [],
        "files": files,
    }))
    .unwrap()
}

/// `files_gz` as the pool sends it: the list's JSON, gzip, base64.
fn files_gz(files: &[String]) -> String {
    use base64::Engine;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(serde_json::to_string(files).unwrap().as_bytes())
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(gz.finish().unwrap())
}

/// One package of a page, as `GET /releases/:ring?include=files` returns it.
fn indexed(source: &str, m: &PackageManifest, gz: &str) -> Value {
    let mut v = serde_json::to_value(m).unwrap();
    let o = v.as_object_mut().unwrap();
    o.remove("files");
    o.insert("source".into(), json!(source));
    o.insert("repo_arch".into(), json!("x86_64"));
    o.insert("files_gz".into(), json!(gz));
    v
}

/// What the render's pool saw: each request in order, and the databases it was given.
#[derive(Default)]
struct Rendered {
    log: Vec<String>,
    artifacts: BTreeMap<(String, String), Vec<u8>>,
}

/// A pool serving release 1076 in `pages` (their package objects, in the order given), taking its
/// databases. The pool signs (`/status`), as the real one does.
fn render_pool(pages: &[Vec<Value>]) -> (String, Arc<Mutex<Rendered>>) {
    let seen = Arc::new(Mutex::new(Rendered::default()));
    let total: usize = pages.iter().map(Vec::len).sum();
    // page.next of page i: the cursor the client sends back for page i + 1.
    let bodies: Vec<String> = pages
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let next = (i + 1 < pages.len()).then(|| format!("cursor-{}", i + 1));
            json!({ "release": release_row(1076), "package_count": total, "artifacts": [], "page": { "next": next }, "packages": p }).to_string()
        })
        .collect();
    let log = Arc::clone(&seen);
    let base = serve(Arc::new(move |h: &Head, body: &mut dyn Read| {
        let mut s = log.lock().unwrap();
        s.log.push(format!("{} {}", h.method, h.path()));
        match (h.method.as_str(), h.path()) {
            ("GET", "/api/v1/status") => answer(200, &json!({ "signing": true })),
            ("GET", "/api/v1/releases/edge") => {
                assert_eq!(h.query("include").as_deref(), Some("files"));
                let i = h
                    .query("after")
                    .map_or(0, |c| c.trim_start_matches("cursor-").parse().unwrap());
                // Every page after the first is pinned to the release the first one returned.
                assert_eq!(h.query("release_id").is_some(), i > 0, "{}", h.target);
                Answer::Body(200, bodies[i].clone().into_bytes())
            }
            ("PUT", p) if p.starts_with("/api/v1/releases/1076/artifacts/") => {
                let kind = p.rsplit('/').next().unwrap().to_owned();
                let mut b = Vec::new();
                body.read_to_end(&mut b).unwrap();
                assert_eq!(b.len() as u64, h.len);
                s.artifacts.insert((h.query("repo").unwrap(), kind), b);
                answer(201, &json!({}))
            }
            ("POST", "/api/v1/releases/1076/rendered") => {
                s.log.push(format!("rendered {}", h.query("arch").unwrap()));
                answer(200, &json!({ "dropped": 0 }))
            }
            ("POST", "/api/v1/events") => answer(201, &json!({})),
            _ => answer(404, &json!({ "error": "not found" })),
        }
    }));
    (base, seen)
}

/// The packages of two sources, interleaved by name as the pool pages them (name, arch, source),
/// two to a page, and what each source's database must hold.
fn ring_of_two_sources() -> (Vec<Vec<Value>>, BTreeMap<String, Vec<PackageManifest>>) {
    let rows = [
        ("acl", "core"),
        ("alsa", "extra"),
        ("bash", "core"),
        ("curl", "extra"),
        ("curl", "core"),
        ("glibc", "core"),
        ("zsh", "extra"),
    ];
    let mut by_source: BTreeMap<String, Vec<PackageManifest>> = BTreeMap::new();
    let mut flat = Vec::new();
    for (name, source) in rows {
        let files: Vec<String> = (0..3)
            .map(|i| format!("/usr/share/{name}/{source}-{i}"))
            .collect();
        let m = manifest(name, &files);
        flat.push(indexed(source, &m, &files_gz(&files)));
        by_source.entry(source.to_owned()).or_default().push(m);
    }
    (flat.chunks(2).map(<[Value]>::to_vec).collect(), by_source)
}

#[test]
fn a_render_read_a_page_at_a_time_uploads_the_databases_the_whole_release_made_then_says_so() {
    let (pages, by_source) = ring_of_two_sources();
    let (base, seen) = render_pool(&pages);
    let api = Api::new(&base, "omj.render").unwrap();
    let repos = pkg_repo::ops::render(&api, "edge", "x86_64", None).unwrap();
    assert_eq!(repos, ["omarchy-core-edge", "omarchy-extra-edge"]);
    let seen = seen.lock().unwrap();
    for (source, packages) in &by_source {
        let packages = pkg_repo::ops::sorted(packages.clone());
        for (kind, flavor) in [("db", Flavor::Db), ("files", Flavor::Files)] {
            assert_eq!(
                seen.artifacts[&(format!("omarchy-{source}-edge"), kind.to_owned())],
                build_database(&packages, flavor).unwrap(),
                "{source} {kind}: the bytes of the whole-release render"
            );
        }
    }
    // Four pages read, then four databases put, then the pool told the render is whole, then the event.
    let order: Vec<&str> = seen
        .log
        .iter()
        .map(String::as_str)
        .filter(|l| !l.starts_with("GET /api/v1/status"))
        .collect();
    assert_eq!(
        order,
        [
            "GET /api/v1/releases/edge",
            "GET /api/v1/releases/edge",
            "GET /api/v1/releases/edge",
            "GET /api/v1/releases/edge",
            "PUT /api/v1/releases/1076/artifacts/db",
            "PUT /api/v1/releases/1076/artifacts/files",
            "PUT /api/v1/releases/1076/artifacts/db",
            "PUT /api/v1/releases/1076/artifacts/files",
            "POST /api/v1/releases/1076/rendered",
            "rendered x86_64",
            "POST /api/v1/events",
        ]
    );
}

#[test]
fn a_page_out_of_name_order_renders_nothing() {
    let (mut pages, _) = ring_of_two_sources();
    // glibc of core before bash of core: a repeat or a step back of the pages' order.
    pages.swap(1, 2);
    let (base, seen) = render_pool(&pages);
    let api = Api::new(&base, "omj.render").unwrap();
    let err = pkg_repo::ops::render(&api, "edge", "x86_64", None).unwrap_err();
    assert!(format!("{err:#}").contains("not in name order"), "{err:#}");
    let seen = seen.lock().unwrap();
    assert!(seen.artifacts.is_empty(), "nothing put");
    assert!(!seen.log.iter().any(|l| l.contains("rendered")));
}

// ---------- under a data rlimit (Linux) ----------

/// Runs the built `pkg-repo` with `args` under a data rlimit of `limit_mb`, with the malloc arenas
/// a pool job's process gets (`dispatch::jobs::MALLOC_ARENAS`).
#[cfg(target_os = "linux")]
fn limited(limit_mb: u64, args: &[&str]) -> std::process::Output {
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "ulimit -d {} && exec \"$0\" \"$@\"",
            limit_mb * 1024
        ))
        .arg(env!("CARGO_BIN_EXE_pkg-repo"))
        .args(args)
        .env("MALLOC_ARENA_MAX", pkg_repo::dispatch::jobs::MALLOC_ARENAS)
        .env("TMPDIR", std::env::temp_dir())
        .output()
        .unwrap()
}

/// A ring whose file lists are more than the limit holds — `PACKAGES` packages of `FILES` paths
/// each, every list the same so the pool's pages are cheap to make — rendered within it.
#[cfg(target_os = "linux")]
#[test]
fn a_ring_whose_file_lists_outgrow_the_limit_renders_within_it() {
    const PACKAGES: usize = 1500;
    const FILES: usize = 1000;
    const LIMIT_MB: u64 = 64;
    let files: Vec<String> = (0..FILES)
        .map(|i| {
            format!("/usr/share/a-long-enough-directory-name/of-some-package/file-{i:06}.data")
        })
        .collect();
    let gz = files_gz(&files);
    let rows: Vec<Value> = (0..PACKAGES)
        .map(|i| indexed("extra", &manifest(&format!("pkg-{i:05}"), &[]), &gz))
        .collect();
    let pages: Vec<Vec<Value>> = rows.chunks(500).map(<[Value]>::to_vec).collect();
    let (base, seen) = render_pool(&pages);
    let out = limited(
        LIMIT_MB,
        &[
            "render",
            "--api",
            &base,
            "--token",
            "omj.render",
            "--ring",
            "edge",
            "--arch",
            "x86_64",
        ],
    );
    assert!(
        out.status.success(),
        "{:?}: {}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    let seen = seen.lock().unwrap();
    let files_db = &seen.artifacts[&("omarchy-extra-edge".to_owned(), "files".to_owned())];
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(&files_db[..]));
    let lists = archive
        .entries()
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .is_ok_and(|e| e.path().unwrap().ends_with("files"))
        })
        .count();
    assert_eq!(lists, PACKAGES, "every package's list in the database");
    assert!(seen.log.iter().any(|l| l == "rendered x86_64"));
}

// ---------- the sync's imports (Linux) ----------

/// A plain tar package: its `.PKGINFO` and one member of `size` bytes that starts with the ELF magic
/// (the extraction holds such a member whole), zeros after it.
#[cfg(target_os = "linux")]
fn package(path: &std::path::Path, name: &str, size: u64) {
    let f = std::fs::File::create(path).unwrap();
    let mut tar = tar::Builder::new(std::io::BufWriter::new(f));
    let pkginfo = format!("pkgname = {name}\npkgbase = {name}\npkgver = 1.0-1\narch = x86_64\nsize = {size}\nbuilddate = 1\n");
    let mut h = tar::Header::new_gnu();
    h.set_size(pkginfo.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    tar.append_data(&mut h, ".PKGINFO", pkginfo.as_bytes())
        .unwrap();
    let mut h = tar::Header::new_gnu();
    h.set_size(size);
    h.set_mode(0o755);
    h.set_cksum();
    let data = std::io::Cursor::new(b"\x7fELF".to_vec()).chain(std::io::repeat(0).take(size - 4));
    tar.append_data(&mut h, format!("usr/lib/{name}/blob"), data)
        .unwrap();
    tar.into_inner().unwrap().flush().unwrap();
}

#[cfg(target_os = "linux")]
fn sha256_of(path: &std::path::Path) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    std::io::copy(&mut std::fs::File::open(path).unwrap(), &mut h).unwrap();
    hex::encode(h.finalize())
}

/// What the sync's pool saw: each package's bytes as they arrived (sha256, length) by sha.
#[cfg(target_os = "linux")]
#[derive(Default)]
struct Imported {
    hashing: std::collections::HashMap<String, (sha2::Sha256, u64)>,
    stored: BTreeMap<String, (String, u64)>,
    indexed: usize,
    releases: Vec<Value>,
}

/// An upstream in `dir`: `count` packages of `size` bytes and their database `big.db`; what each
/// package's bytes hash to, with its length.
#[cfg(target_os = "linux")]
fn upstream(dir: &std::path::Path, count: usize, size: u64) -> BTreeMap<String, u64> {
    let mut db = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::fast(),
    ));
    let mut expected = BTreeMap::new();
    for i in 0..count {
        let name = format!("linux-big{i}");
        let file = format!("{name}-1.0-1-x86_64.pkg.tar");
        package(&dir.join(&file), &name, size);
        let sha = sha256_of(&dir.join(&file));
        let len = std::fs::metadata(dir.join(&file)).unwrap().len();
        let desc = format!("%FILENAME%\n{file}\n\n%NAME%\n{name}\n\n%VERSION%\n1.0-1\n\n%CSIZE%\n{len}\n\n%SHA256SUM%\n{sha}\n\n");
        let mut header = tar::Header::new_gnu();
        header.set_size(desc.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        db.append_data(&mut header, format!("{name}-1.0-1/desc"), desc.as_bytes())
            .unwrap();
        expected.insert(sha, len);
    }
    std::fs::write(
        dir.join("big.db"),
        db.into_inner().unwrap().finish().unwrap(),
    )
    .unwrap();
    expected
}

/// Feeds a body into the hash of the upload `id` (a package's sha256), as it comes.
#[cfg(target_os = "linux")]
fn hash_into(state: &Mutex<Imported>, id: &str, body: &mut dyn Read) {
    use sha2::Digest;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let read = body.read(&mut buf).unwrap();
        if read == 0 {
            break;
        }
        let mut imported = state.lock().unwrap();
        let (hasher, len) = imported.hashing.entry(id.to_owned()).or_default();
        hasher.update(&buf[..read]);
        *len += read as u64;
    }
}

/// The upload `id` is whole: what its bytes hashed to, and how many, are what the pool stored.
#[cfg(target_os = "linux")]
fn stored(state: &Mutex<Imported>, id: &str) {
    use sha2::Digest;
    let mut imported = state.lock().unwrap();
    let (hasher, len) = imported.hashing.remove(id).unwrap_or_default();
    imported
        .stored
        .insert(id.to_owned(), (hex::encode(hasher.finalize()), len));
}

/// The pool a sync imports into, serving the upstream in `dir` under `/upstream/` too: each
/// package's bytes hashed as they arrive, in one request or in parts, never held.
#[cfg(target_os = "linux")]
fn import_pool(dir: PathBuf, state: Arc<Mutex<Imported>>) -> String {
    serve(Arc::new(move |head: &Head, body: &mut dyn Read| {
        let path = head.path().to_owned();
        let mut whole = || {
            let mut bytes = Vec::new();
            body.read_to_end(&mut bytes).unwrap();
            bytes
        };
        match (head.method.as_str(), path.as_str()) {
            ("GET", p) if p.starts_with("/upstream/") => {
                let file = dir.join(p.trim_start_matches("/upstream/"));
                if file.is_file() {
                    Answer::File(file)
                } else {
                    answer(404, &json!({}))
                }
            }
            ("GET", "/api/v1/releases/edge") => {
                answer(404, &json!({ "error": "ring edge has no release yet" }))
            }
            ("POST", "/api/v1/packages/known") => {
                whole();
                answer(200, &json!({ "known": [], "by_filename": {} }))
            }
            ("PUT", p)
                if p.starts_with("/api/v1/pool/") && !p.starts_with("/api/v1/pool/multipart/") =>
            {
                // A package at or below the single-request size: one PUT, hashed as it comes.
                let sha = p.split('/').nth(4).unwrap().to_owned();
                hash_into(&state, &sha, body);
                stored(&state, &sha);
                answer(201, &json!({}))
            }
            ("POST", p) if p.starts_with("/api/v1/pool/") && p.ends_with("/multipart") => {
                let sha = p.split('/').nth(4).unwrap().to_owned();
                answer(
                    200,
                    &json!({ "uploads": [{ "key": format!("k-{sha}"), "uploadId": sha }] }),
                )
            }
            ("PUT", p) if p.starts_with("/api/v1/pool/multipart/") => {
                // /api/v1/pool/multipart/<upload>/part/<n>: hashed as it comes, in order.
                let segments: Vec<&str> = p.split('/').collect();
                let number = segments[7].parse::<u32>().unwrap();
                hash_into(&state, segments[5], body);
                answer(
                    200,
                    &json!({ "partNumber": number, "etag": format!("e{number}") }),
                )
            }
            ("POST", p) if p.starts_with("/api/v1/pool/multipart/") && p.ends_with("/complete") => {
                whole();
                stored(&state, p.split('/').nth(5).unwrap());
                answer(200, &json!({}))
            }
            ("POST", "/api/v1/packages") => {
                whole();
                state.lock().unwrap().indexed += 1;
                answer(201, &json!({}))
            }
            ("POST", "/api/v1/releases") => {
                let asked: Value = serde_json::from_slice(&whole()).unwrap();
                let pinned = asked["add"].as_array().map_or(0, Vec::len);
                state.lock().unwrap().releases.push(asked);
                answer(
                    201,
                    &json!({ "release": release_row(1077), "package_count": pinned, "size_download": 0, "unchanged_arches": ["aarch64"] }),
                )
            }
            ("POST", "/api/v1/events") => {
                whole();
                answer(201, &json!({}))
            }
            _ => answer(
                404,
                &json!({ "error": format!("not here: {} {}", head.method, head.target) }),
            ),
        }
    }))
}

/// `COUNT` packages above the single-request size (90 MB: multipart, 64 MB parts), each with a
/// member the extraction holds whole, imported eight at a time within a limit below what the
/// imports held at once before: every byte arrives, every package is indexed and pinned.
#[cfg(target_os = "linux")]
#[test]
fn large_packages_import_eight_at_a_time_within_the_limit() {
    const COUNT: usize = 4;
    const SIZE: u64 = 96 << 20;
    const LIMIT_MB: u64 = 320;
    let t = tempfile::tempdir().unwrap();
    let up = t.path().join("upstream");
    std::fs::create_dir_all(&up).unwrap();
    let expected = upstream(&up, COUNT, SIZE);
    let state = Arc::new(Mutex::new(Imported::default()));
    let base = import_pool(up, Arc::clone(&state));
    let work = t.path().join("work");
    let out = limited(
        LIMIT_MB,
        &[
            "sync",
            "--api",
            &base,
            "--token",
            "omj.sync",
            "--source",
            "big",
            "--base-url",
            &format!("{base}/upstream"),
            "--db-name",
            "big",
            "--arch",
            "x86_64",
            "--ring",
            "edge",
            "--concurrency",
            "8",
            "--work-dir",
            work.to_str().unwrap(),
        ],
    );
    assert!(
        out.status.success(),
        "{:?}: {}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    let imported = state.lock().unwrap();
    assert_eq!(
        imported.stored.values().cloned().collect::<Vec<_>>(),
        expected.into_iter().collect::<Vec<_>>(),
        "every package's bytes, whole and as upstream hashed them"
    );
    assert_eq!(imported.indexed, COUNT);
    assert_eq!(imported.releases.len(), 1);
    assert_eq!(imported.releases[0]["add"].as_array().unwrap().len(), COUNT);
}
