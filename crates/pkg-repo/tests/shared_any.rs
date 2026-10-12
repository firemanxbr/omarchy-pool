//! An `-any` archive Omarchy ships byte for byte in both architectures' repositories (#421). The
//! pool's index held one row per sha256, so the second architecture's sync of `packages` got a
//! 409 for each such archive and left it out of its rings — `packages x86_64: 0 new, 8 failed` on
//! every sync from at least 2026-10-12. Since migration 0055 the index holds a row per (sha256,
//! repository architecture), and the clients ask about the bytes per architecture.
//!
//! The pool here (`index_pool`, on the shared mock server) is the index as it is now: an object per
//! `<source>/<arch>/<filename>`, a row per (sha256, architecture), `known` and a release's adds
//! per architecture, `GET /packages/:sha256` for the bytes whichever architecture indexed them.

mod mock_pool;

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pkg_repo::client::Api;
use pkg_repo::sync::{SyncOptions, SyncReport};
use serde_json::{json, Value};

use mock_pool::{answer, serve, Answer, Head};

/// What the pool holds and was asked.
#[derive(Default)]
struct Index {
    /// The objects: `<source>/<arch>/<filename>` → the sha256 of its bytes.
    objects: BTreeMap<String, String>,
    /// The index: (sha256, repository architecture) → the object its row names.
    rows: BTreeMap<(String, String), String>,
    /// Each release asked for: its `remove_arch` and its adds.
    releases: Vec<(Option<String>, Vec<String>)>,
    /// The journal's lines.
    events: Vec<Value>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

/// The pool, and the upstream repositories in `upstream` under `/upstream/`.
#[allow(clippy::too_many_lines)]
fn index_pool(upstream: PathBuf, state: Arc<Mutex<Index>>) -> String {
    serve(Arc::new(move |head: &Head, body: &mut dyn Read| {
        let mut whole = || {
            let mut bytes = Vec::new();
            body.read_to_end(&mut bytes).unwrap();
            bytes
        };
        let path = head.path().to_owned();
        let query = |k: &str| head.query(k).unwrap_or_default();
        match (head.method.as_str(), path.as_str()) {
            ("GET", p) if p.starts_with("/upstream/") => {
                let file = upstream.join(p.trim_start_matches("/upstream/"));
                if file.is_file() {
                    Answer::File(file)
                } else {
                    answer(404, &json!({}))
                }
            }
            ("GET", "/api/v1/status") => answer(200, &json!({ "signing": false })),
            ("GET", p) if p.starts_with("/api/v1/releases/") => {
                answer(404, &json!({ "error": "ring edge has no release yet" }))
            }
            ("POST", "/api/v1/packages/known") => {
                let asked: Value = serde_json::from_slice(&whole()).unwrap();
                let (arch, source) = (
                    asked["arch"].as_str().unwrap().to_owned(),
                    asked["source"].as_str().unwrap_or_default(),
                );
                let s = state.lock().unwrap();
                let known: Vec<&str> = asked["sha256"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|sha| s.rows.contains_key(&((*sha).to_owned(), arch.clone())))
                    .collect();
                let mut by_filename = serde_json::Map::new();
                for f in asked["filenames"].as_array().into_iter().flatten() {
                    let key = format!("{source}/{arch}/{}", f.as_str().unwrap());
                    if let Some(((sha, _), _)) = s
                        .rows
                        .iter()
                        .find(|((_, a), named)| *a == arch && **named == key)
                    {
                        by_filename.insert(f.as_str().unwrap().to_owned(), json!(sha));
                    }
                }
                answer(200, &json!({ "known": known, "by_filename": by_filename }))
            }
            ("GET", p) if p.starts_with("/api/v1/packages/") => {
                // The bytes' manifest, whichever architecture indexed them.
                let sha = p.rsplit('/').next().unwrap();
                if state.lock().unwrap().rows.keys().any(|(x, _)| x == sha) {
                    answer(200, &json!({ "sha256": sha }))
                } else {
                    answer(404, &json!({ "error": "no package with this sha256" }))
                }
            }
            ("PUT", p) if p.starts_with("/api/v1/pool/") && p.ends_with("/sig") => {
                whole();
                answer(201, &json!({ "status": "stored" }))
            }
            ("PUT", p) if p.starts_with("/api/v1/pool/") => {
                let sha = p.split('/').nth(4).unwrap().to_owned();
                let key = format!(
                    "{}/{}/{}",
                    query("source"),
                    query("arch"),
                    query("filename")
                );
                let bytes = whole();
                let mut s = state.lock().unwrap();
                if s.objects.contains_key(&key) {
                    return answer(200, &json!({ "key": key, "status": "already-present" }));
                }
                // R2 checks the bytes against the sha256 the key is claimed for.
                if sha256_hex(&bytes) != sha {
                    return answer(422, &json!({ "error": "integrity check failed" }));
                }
                s.objects.insert(key.clone(), sha);
                answer(201, &json!({ "key": key, "status": "stored" }))
            }
            ("POST", "/api/v1/packages") => {
                let m: Value = serde_json::from_slice(&whole()).unwrap();
                let (source, arch) = (query("source"), query("arch"));
                let sha = m["sha256"].as_str().unwrap().to_owned();
                let key = format!("{source}/{arch}/{}", m["filename"].as_str().unwrap());
                let mut s = state.lock().unwrap();
                if !s.objects.contains_key(&key) {
                    return answer(
                        409,
                        &json!({ "error": "archive not in pool; upload it first" }),
                    );
                }
                if s.rows.contains_key(&(sha.clone(), arch.clone())) {
                    return answer(200, &json!({ "sha256": sha, "status": "already-indexed" }));
                }
                s.rows.insert((sha.clone(), arch), key);
                answer(201, &json!({ "sha256": sha, "status": "indexed" }))
            }
            ("POST", "/api/v1/releases") => {
                let asked: Value = serde_json::from_slice(&whole()).unwrap();
                let arch = asked["remove_arch"].as_str().map(str::to_owned);
                let add: Vec<String> = asked["add"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect();
                let mut s = state.lock().unwrap();
                // An add is the bytes' row of the architecture the release is scoped to.
                let missing: Vec<&String> = add
                    .iter()
                    .filter(|sha| {
                        !s.rows
                            .keys()
                            .any(|(x, a)| x == *sha && arch.as_ref().is_none_or(|w| w == a))
                    })
                    .collect();
                if !missing.is_empty() {
                    return answer(
                        404,
                        &json!({ "error": format!("packages not indexed: {}", missing.iter().map(|m| m.as_str()).collect::<Vec<_>>().join(", ")) }),
                    );
                }
                let n = add.len();
                s.releases.push((arch, add));
                let id = s.releases.len();
                answer(
                    201,
                    &json!({ "release": { "id": id, "ring": "edge", "seq": id, "parent_id": null, "source_id": null, "note": null, "created_at": "2026-10-12T12:00:00Z" }, "package_count": n, "size_download": 0, "unchanged_arches": [] }),
                )
            }
            ("POST", "/api/v1/events") => {
                let event: Value = serde_json::from_slice(&whole()).unwrap();
                state.lock().unwrap().events.push(event);
                answer(201, &json!({}))
            }
            _ => answer(
                404,
                &json!({ "error": format!("not here: {} {}", head.method, head.target) }),
            ),
        }
    }))
}

/// A package as makepkg writes one: a zstd tar with its `.PKGINFO` and one file.
fn package(name: &str, arch: &str) -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    let pkginfo = format!("pkgname = {name}\npkgbase = {name}\npkgver = 1.0-1\narch = {arch}\nsize = 5\nbuilddate = 1\n");
    for (path, bytes) in [
        (".PKGINFO".to_owned(), pkginfo.as_bytes()),
        (format!("usr/share/{name}/data"), &b"data\n"[..]),
    ] {
        let mut h = tar::Header::new_gnu();
        h.set_size(bytes.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        tar.append_data(&mut h, path, bytes).unwrap();
    }
    zstd::encode_all(&tar.into_inner().unwrap()[..], 3).unwrap()
}

/// An upstream repository of `arch` in `dir/<arch>/`: the packages, and its `packages.db`.
fn repository(dir: &Path, arch: &str, packages: &[(&str, &str, &[u8])]) {
    let here = dir.join(arch);
    std::fs::create_dir_all(&here).unwrap();
    let mut db = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::fast(),
    ));
    for (name, filename, bytes) in packages {
        std::fs::write(here.join(filename), bytes).unwrap();
        let desc = format!(
            "%FILENAME%\n{filename}\n\n%NAME%\n{name}\n\n%VERSION%\n1.0-1\n\n%CSIZE%\n{}\n\n%SHA256SUM%\n{}\n\n",
            bytes.len(),
            sha256_hex(bytes)
        );
        let mut h = tar::Header::new_gnu();
        h.set_size(desc.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        db.append_data(&mut h, format!("{name}-1.0-1/desc"), desc.as_bytes())
            .unwrap();
    }
    std::fs::write(
        here.join("packages.db"),
        db.into_inner().unwrap().finish().unwrap(),
    )
    .unwrap();
}

/// `pkg-repo sync` of Omarchy's repository for `arch`, as the scheduler's job runs it.
fn sync(api: &Api, base: &str, arch: &str, work: &Path) -> SyncReport {
    pkg_repo::sync::run(
        api,
        &SyncOptions {
            source: "packages".into(),
            upstream: String::new(),
            base_url: Some(format!("{base}/upstream/{arch}")),
            db_name: Some("packages".into()),
            arch: arch.into(),
            ring: "edge".into(),
            limit: 0,
            concurrency: 2,
            work_dir: work.join(arch),
            dry_run: false,
            keyring: None,
            defer_to: vec![],
            defer_release: false,
        },
    )
    .unwrap()
}

const ANY: &str = "omazed-1.0-1-any.pkg.tar.zst";

#[test]
fn an_any_archive_both_repositories_ship_byte_for_byte_is_synced_into_both() {
    let t = tempfile::tempdir().unwrap();
    let up = t.path().join("upstream");
    let any = package("omazed", "any");
    let (arm, x86) = (package("tool", "aarch64"), package("tool", "x86_64"));
    repository(
        &up,
        "aarch64",
        &[
            ("omazed", ANY, &any),
            ("tool", "tool-1.0-1-aarch64.pkg.tar.zst", &arm),
        ],
    );
    repository(
        &up,
        "x86_64",
        &[
            ("omazed", ANY, &any),
            ("tool", "tool-1.0-1-x86_64.pkg.tar.zst", &x86),
        ],
    );
    let state = Arc::new(Mutex::new(Index::default()));
    let base = index_pool(up, Arc::clone(&state));
    let api = Api::new(&base, "omj.sync").unwrap();
    let any_sha = sha256_hex(&any);

    // aarch64's sync first, as on 2026-10-12. x86_64's object of the archive is already in the
    // pool: its upload went through on every run before #421, its index was the 409.
    state
        .lock()
        .unwrap()
        .objects
        .insert(format!("packages/x86_64/{ANY}"), any_sha.clone());
    for arch in ["aarch64", "x86_64"] {
        let report = sync(&api, &base, arch, t.path());
        assert!(report.failed.is_empty(), "{arch}: {:?}", report.failed);
        assert_eq!(report.uploaded, 2, "{arch}: both packages imported");
        assert!(
            report.collisions.is_empty(),
            "{arch}: {:?}",
            report.collisions
        );
    }

    let s = state.lock().unwrap();
    // A row for each architecture of the same bytes, each naming its architecture's object.
    assert_eq!(
        s.rows.get(&(any_sha.clone(), "aarch64".to_owned())),
        Some(&format!("packages/aarch64/{ANY}"))
    );
    assert_eq!(
        s.rows.get(&(any_sha.clone(), "x86_64".to_owned())),
        Some(&format!("packages/x86_64/{ANY}"))
    );
    assert_eq!(s.objects[&format!("packages/aarch64/{ANY}")], any_sha);
    assert_eq!(s.objects[&format!("packages/x86_64/{ANY}")], any_sha);
    // Each architecture's release pins it, scoped to that architecture.
    let pinned: Vec<(Option<&str>, BTreeSet<&str>)> = s
        .releases
        .iter()
        .map(|(a, add)| (a.as_deref(), add.iter().map(String::as_str).collect()))
        .collect();
    assert_eq!(
        pinned,
        [
            (
                Some("aarch64"),
                BTreeSet::from([any_sha.as_str(), sha256_hex(&arm).as_str()])
            ),
            (
                Some("x86_64"),
                BTreeSet::from([any_sha.as_str(), sha256_hex(&x86).as_str()])
            ),
        ]
    );
    // And the journal says so: no failure on either architecture.
    let syncs: Vec<&Value> = s.events.iter().filter(|e| e["kind"] == "sync").collect();
    assert_eq!(syncs.len(), 2);
    for e in syncs {
        assert_eq!(e["status"], "ok", "{e}");
        assert_eq!(e["payload"]["failed"], json!([]), "{e}");
    }
    drop(s);

    // The next runs find their own rows: nothing to import, nothing failed.
    for arch in ["aarch64", "x86_64"] {
        let again = sync(&api, &base, arch, t.path());
        assert!(again.failed.is_empty(), "{arch}: {:?}", again.failed);
        assert_eq!((again.uploaded, again.already_indexed), (0, 2), "{arch}");
    }
}

#[test]
fn an_any_archive_published_for_both_architectures_is_indexed_for_each() {
    let t = tempfile::tempdir().unwrap();
    let archive = t.path().join(ANY);
    let any = package("omazed", "any");
    std::fs::File::create(&archive)
        .unwrap()
        .write_all(&any)
        .unwrap();
    let state = Arc::new(Mutex::new(Index::default()));
    let base = index_pool(t.path().join("upstream"), Arc::clone(&state));
    let api = Api::new(&base, "omj.publish").unwrap();
    // aarch64 first; then x86_64, which asked whether the bytes were indexed at all (they were,
    // for aarch64), skipped its upload and its index, and had its release refused.
    for arch in ["aarch64", "x86_64"] {
        pkg_repo::ops::publish(
            &api,
            "edge",
            "packages",
            arch,
            None,
            std::slice::from_ref(&archive),
        )
        .unwrap_or_else(|e| panic!("{arch}: {e:#}"));
    }
    let s = state.lock().unwrap();
    let any_sha = sha256_hex(&any);
    assert_eq!(
        s.rows.keys().cloned().collect::<Vec<_>>(),
        [
            (any_sha.clone(), "aarch64".to_owned()),
            (any_sha.clone(), "x86_64".to_owned())
        ]
    );
    assert_eq!(
        s.objects.len(),
        2,
        "an object in each architecture's directory"
    );
    assert_eq!(
        s.releases,
        [
            (Some("aarch64".to_owned()), vec![any_sha.clone()]),
            (Some("x86_64".to_owned()), vec![any_sha])
        ]
    );
}
