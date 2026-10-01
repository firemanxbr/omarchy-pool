//! What each kind runs in P1 (design v2 §9.2), on the dispatcher's side of a
//! task container: staging its inputs before it starts (D47) and, after it
//! exits, checking its outputs against the kind's closed list and size caps,
//! uploading them with the lease's job token and reporting (§9.6).
//!
//! - a **build** (a contributor's recipe, a draft, a bump, the project's
//!   review rebuild, the project's recipe on main): `meta.sh` and whatever
//!   evidence its recipe learns from are staged in `/task/in`; the packages,
//!   the recipe, the gate and `verdict.json` come back in `/task/out` and the
//!   log in `/task/log`. A contributor's build and the project's review
//!   rebuild go to the task's staging; the project's recipe on main is
//!   published into edge with the lease's `pool:write`, as `pkg-repo work`
//!   does; a dry run stays on the host (#284).
//! - an **audit**: the staged PKGBUILD, log, gate and `.PKGINFO` in
//!   `/task/in`, read as data; `audit.json` and `audit.md` attached to the
//!   staged build.
//! - a **trial**: the dispatcher's trusted steps — the staged packages
//!   published into `lab`, `lab` rendered — then the helper container, which
//!   installs from the public lab URL with no token; its transcript attached
//!   as `trial.log`.
//!
//! Seam: a correction of a failed draft runs today inside the build's own
//! container (the script's attempts). The agent sidecars child issue, which
//! attaches the agent, moves it to a new container in the same lease, with
//! the failed PKGBUILD and log as its input, so the agent never meets the
//! container that ran the recipe.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::capacity::Constants;
use super::engine::State;
use super::lease::Lease;
use super::pool::Pool;
use super::spec::{self, Kind};
use crate::orders::clean_line;
use crate::RepoError;

/// A task's log is cut here by its container's entrypoint (and marked); anything longer was not written by it.
pub const LOG_CAP: u64 = 64 << 20;
const MIB: u64 = 1 << 20;

/// What the loop knows that the kinds need.
pub struct Ctx {
    pub pool: Arc<dyn Pool>,
    pub work_root: PathBuf,
    /// The pool's package repositories (`OMARCHY_POOL`): what a build resolves its dependencies against.
    pub pool_url: String,
    /// A release checkout to mount instead of `work/releases/<release>` (tests, and a host that keeps its own).
    pub checkout: Option<PathBuf>,
    pub constants: Constants,
}

impl Ctx {
    pub fn task_dir(&self, l: &Lease) -> PathBuf {
        spec::task_dir(&self.work_root, l.task.id, &l.gen)
    }

    /// The release's checkout, the one its containers mount at `/pool`.
    pub fn release_dir(&self, release: &str) -> PathBuf {
        self.checkout
            .clone()
            .unwrap_or_else(|| self.work_root.join("releases").join(release))
    }
}

/// Why a preparation did not end in a container to start.
#[derive(Debug)]
pub enum Prep {
    /// The task fails, with this report.
    Fail(Value),
    /// Not now (a pool or GitHub that does not answer): the loop tries again.
    Retry(String),
}

/// A finish that must be tried again (the pool did not answer); the container stays.
#[derive(Debug)]
pub struct Retry(pub String);

/// The container kind a lease runs.
pub fn kind_of(l: &Lease) -> Option<Kind> {
    match l.task.kind.as_str() {
        "build" => Some(
            if l.task.pkgbuild_ref.starts_with("draft:")
                || l.task.pkgbuild_ref.starts_with("review:")
            {
                Kind::ModelBuild
            } else {
                Kind::Build
            },
        ),
        "audit" => Some(Kind::Audit),
        "trial" => Some(Kind::Trial),
        _ => None,
    }
}

fn fail_body(error: &str, is_final: bool) -> Value {
    json!({ "error": error, "final": is_final, "needs_native": false })
}

fn retry_of(e: impl std::fmt::Display) -> Prep {
    Prep::Retry(clean_line(&e.to_string()))
}

/// Inside the container `localhost` is the container: a local pool (wrangler dev) is reached through the engine's host alias.
fn from_container(u: &str) -> String {
    u.replace("://localhost", "://host.containers.internal")
        .replace("://127.0.0.1", "://host.containers.internal")
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn param_task(p: &Value, key: &str) -> Option<u64> {
    p.get(key)
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|x| x.parse().ok()))
        })
        .filter(|&n| n > 0)
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

// ---------- staging in ----------

/// Stages a lease's inputs in `<task dir>/in` (and, for a trial, publishes the lab):
/// the task directory made fresh, the release's checkout present. Returns the notes the
/// finish needs.
pub fn prepare(ctx: &Ctx, l: &Lease, stop: &AtomicBool) -> Result<Value, Prep> {
    let dir = ctx.task_dir(l);
    let _ = std::fs::remove_dir_all(&dir);
    for sub in ["in", "out", "log", "build", "pkgcache"] {
        std::fs::create_dir_all(dir.join(sub)).map_err(retry_of)?;
    }
    let rel = ctx.release_dir(&l.release);
    ensure_checkout(&rel, &l.release).map_err(retry_of)?;
    let input = dir.join("in");
    let notes = match l.task.kind.as_str() {
        "build" => stage_build(ctx, l, &input)?,
        "audit" => stage_audit(ctx, l, &input)?,
        "trial" => stage_trial(ctx, l, &dir, &rel, stop)?,
        other => {
            return Err(Prep::Fail(fail_body(
                &format!("this dispatcher runs builds, trials and audits in P1, not {other}"),
                false,
            )))
        }
    };
    if stop.load(Ordering::SeqCst) {
        return Err(Prep::Retry("stopped".into()));
    }
    Ok(notes)
}

/// `<work root>/releases/<release>`: the release's own checkout, cloned once at its tag
/// (a dev build's at main), and never changed after (a tag does not move).
fn ensure_checkout(dir: &Path, release: &str) -> anyhow::Result<()> {
    // Two leases prepared at once (a build and an audit) clone one release once, not into each other.
    static CLONING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = CLONING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if dir.join("factory/worker/omarchy-build-worker.sh").is_file() {
        return Ok(());
    }
    let tmp = dir.with_extension("new");
    let _ = std::fs::remove_dir_all(&tmp);
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let git_ref = if release.starts_with('v') {
        release
    } else {
        "main"
    };
    let ok = std::process::Command::new("git")
        .args([
            "clone",
            "-q",
            "--depth",
            "1",
            "--branch",
            git_ref,
            crate::work::REPO_URL,
        ])
        .arg(&tmp)
        .status()
        .is_ok_and(|s| s.success());
    anyhow::ensure!(ok, "could not clone {} at {git_ref}", crate::work::REPO_URL);
    let _ = std::fs::remove_dir_all(dir);
    std::fs::rename(&tmp, dir)?;
    Ok(())
}

fn write_meta(input: &Path, lines: &[(&str, String)]) -> Result<(), Prep> {
    use std::fmt::Write as _;
    let mut meta = String::from("staged=1\n");
    for (k, v) in lines {
        let _ = writeln!(meta, "{k}={}", shell_quote(v));
    }
    std::fs::write(input.join("meta.sh"), meta).map_err(retry_of)
}

/// Fetches artifacts of task `of` into `in/artifacts/<of>/`; the missing ones are left out.
fn fetch_artifacts(
    ctx: &Ctx,
    l: &Lease,
    input: &Path,
    of: u64,
    names: &[&str],
) -> Result<Vec<String>, Prep> {
    let to = input.join("artifacts").join(of.to_string());
    std::fs::create_dir_all(&to).map_err(retry_of)?;
    let mut have = Vec::new();
    for n in names {
        if ctx
            .pool
            .fetch(&l.token, of, n, &to.join(n))
            .map_err(retry_of)?
        {
            have.push((*n).to_owned());
        }
    }
    Ok(have)
}

/// What a recipe learns from: another build's recipe, its log, its gate, its audit.
const EVIDENCE: [&str; 4] = ["PKGBUILD", "build.log", "tests.log", "audit.md"];

fn stage_build(ctx: &Ctx, l: &Lease, input: &Path) -> Result<Value, Prep> {
    let t = &l.task;
    if l.staging_full {
        return Err(Prep::Fail(fail_body(
            "staging quota reached: drop a build with DELETE /api/v1/factory/tasks/<id>/artifacts, or wait — superseded, rejected and published builds are reclaimed by the pool",
            true,
        )));
    }
    let mut meta: Vec<(&str, String)> = vec![
        ("kind", "build".into()),
        ("name", t.name.clone()),
        ("ref", t.pkgbuild_ref.clone()),
        ("arch", t.arch.clone()),
        ("pool", from_container(&ctx.pool_url)),
    ];
    if let Some(from) = t.pkgbuild_ref.strip_prefix("review:") {
        let from: u64 = from.parse().map_err(|_| {
            Prep::Fail(fail_body(
                &format!("{} is not review:<task>", t.pkgbuild_ref),
                true,
            ))
        })?;
        fetch_artifacts(ctx, l, input, from, &EVIDENCE)?;
        for (var, key) in [
            ("review_url", "project"),
            ("review_source", "source"),
            ("review_version", "version"),
            ("review_desc", "description"),
            ("review_license", "license"),
        ] {
            let v = s(&t.params, key);
            if !v.is_empty() {
                meta.push((var, v));
            }
        }
    } else if let Some(spec) = t.pkgbuild_ref.strip_prefix("bump:") {
        let from: u64 = spec
            .split_once('@')
            .and_then(|(f, _)| f.parse().ok())
            .ok_or_else(|| {
                Prep::Fail(fail_body(
                    &format!("{} is not bump:<task>@<tag>", t.pkgbuild_ref),
                    true,
                ))
            })?;
        if fetch_artifacts(ctx, l, input, from, &["PKGBUILD"])?.is_empty() {
            return Err(Prep::Fail(fail_body(
                &format!("the approved PKGBUILD of task {from} is not staged"),
                true,
            )));
        }
    }
    if let Some(lesson) = param_task(&t.params, "lesson") {
        fetch_artifacts(ctx, l, input, lesson, &EVIDENCE)?;
        meta.push(("lesson", lesson.to_string()));
    }
    let hint = s(&t.params, "hint");
    if !hint.is_empty() {
        meta.push(("hint", hint));
    }
    write_meta(input, &meta)?;
    Ok(Value::Null)
}

fn stage_audit(ctx: &Ctx, l: &Lease, input: &Path) -> Result<Value, Prep> {
    let t = &l.task;
    let staged = param_task(&t.params, "task")
        .ok_or_else(|| Prep::Fail(fail_body("audit needs `task`, the staged build's id", true)))?;
    let have = fetch_artifacts(
        ctx,
        l,
        input,
        staged,
        &["PKGBUILD", "build.log", "PKGINFO", "tests.log"],
    )?;
    for need in ["PKGBUILD", "build.log"] {
        if !have.iter().any(|h| h == need) {
            return Err(Prep::Fail(fail_body(
                &format!("staged task {staged} has no {need}"),
                false,
            )));
        }
    }
    write_meta(
        input,
        &[
            ("kind", "audit".into()),
            ("name", t.name.clone()),
            ("arch", t.arch.clone()),
            ("staged_task", staged.to_string()),
        ],
    )?;
    Ok(json!({ "staged": staged }))
}

/// A package file name as makepkg writes it and the pool stores it.
pub fn package_file_ok(f: &str) -> bool {
    f.strip_suffix(".pkg.tar.zst").is_some_and(|stem| {
        !stem.is_empty()
            && stem.as_bytes()[0].is_ascii_alphanumeric()
            && stem.bytes().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, b'@' | b'.' | b'_' | b'+' | b'-' | b':')
            })
    })
}

#[allow(clippy::too_many_lines)] // the trusted steps, then the helper's inputs: one sequence
fn stage_trial(
    ctx: &Ctx,
    l: &Lease,
    dir: &Path,
    rel: &Path,
    stop: &AtomicBool,
) -> Result<Value, Prep> {
    let t = &l.task;
    let built = param_task(&t.params, "task").ok_or_else(|| {
        Prep::Fail(fail_body(
            "trial: params.task names the project's build",
            true,
        ))
    })?;
    let files: Vec<String> = t
        .params
        .get("files")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if files.is_empty() {
        return Err(Prep::Fail(fail_body(
            "trial: params.files lists the staged packages",
            true,
        )));
    }
    // The trusted steps: on the dispatcher's side only, never in a directory a container mounts.
    let trusted = dir.join("trusted");
    std::fs::create_dir_all(&trusted).map_err(retry_of)?;
    let mut pkgs = Vec::new();
    for f in &files {
        if !package_file_ok(f) {
            return Err(Prep::Fail(fail_body(
                &format!("trial: {f} is not a package file name"),
                true,
            )));
        }
        if stop.load(Ordering::SeqCst) {
            return Err(Prep::Retry("stopped".into()));
        }
        let dest = trusted.join(f);
        ctx.pool
            .fetch_private(&l.token, built, f, &dest)
            .map_err(retry_of)?;
        pkgs.push(dest);
    }
    pkgs.sort();
    let names: Vec<String> = pkgs
        .iter()
        .filter_map(|p| pkg_extract::extract_manifest(p).ok().map(|m| m.name))
        .collect();
    if names.is_empty() || names.iter().any(|n| !spec::name_ok(n)) {
        return Err(Prep::Fail(fail_body(
            "trial: no package could be read, or a name is outside the grammar",
            true,
        )));
    }
    let rendered = ctx
        .pool
        .publish(
            &l.token,
            "lab",
            &t.arch,
            &format!(
                "trial of factory task {built}: {} — into the lab, not promised",
                t.name
            ),
            &pkgs,
            false,
        )
        .map_err(retry_of)?;
    let _ = std::fs::remove_dir_all(&trusted);
    // The helper's inputs, as tests/trial.sh writes them: the include `--ring lab` hands a
    // machine (public), the pool's key and the projects' keyrings, the packages' names and
    // the check itself.
    let keyrings = crate::work::keyrings_in(&ctx.work_root.join("keyrings"), rel, &[]).ok();
    let input = dir.join("in");
    let mut cmd = std::process::Command::new("bash");
    cmd.arg(rel.join("tests/trial.sh"))
        .arg(&t.arch)
        .arg(built.to_string())
        .args(&names)
        .env("TRIAL_STAGE", &input)
        .env("OMARCHY_API", ctx.pool.api_url())
        .env_remove("OMARCHY_TOKEN")
        .env_remove("OMARCHY_WORKER_TOKEN");
    if let Some(k) = keyrings {
        cmd.env("OMARCHY_KEYRINGS", k);
    }
    let out = cmd.output().map_err(retry_of)?;
    if !out.status.success() {
        return Err(Prep::Fail(fail_body(
            &format!(
                "trial: its inputs could not be staged: {}",
                clean_line(&String::from_utf8_lossy(&out.stdout))
            ),
            false,
        )));
    }
    write_meta(
        &input,
        &[
            ("kind", "trial".into()),
            ("name", t.name.clone()),
            ("arch", t.arch.clone()),
            ("built_task", built.to_string()),
            (
                "keyring",
                if t.arch == "aarch64" {
                    "archlinuxarm"
                } else {
                    "archlinux"
                }
                .into(),
            ),
        ],
    )?;
    Ok(json!({ "built": built, "packages": names, "rendered": rendered }))
}

// ---------- outputs ----------

/// The kind's closed list: a name (or the package pattern) and its size cap.
fn allowed(kind: &str, name: &str) -> Option<u64> {
    let fixed: &[(&str, u64)] = match kind {
        "build" => &[
            ("PKGBUILD", MIB),
            ("vet.json", 4 * MIB),
            ("tests.log", 16 * MIB),
            ("resources.json", MIB),
            ("verdict.json", 64 << 10),
        ],
        "audit" => &[
            ("audit.json", MIB),
            ("audit.md", MIB),
            ("verdict.json", 64 << 10),
        ],
        "trial" => &[("verdict.json", 64 << 10)],
        _ => &[],
    };
    if let Some((_, cap)) = fixed.iter().find(|(n, _)| *n == name) {
        return Some(*cap);
    }
    (kind == "build" && package_file_ok(name)).then_some(2 << 30)
}

/// The outputs, checked against the kind's list and caps: regular files only (a link
/// could point anywhere the dispatcher sees), at most 64. `Err` says what was refused;
/// nothing is uploaded then.
pub fn check_outputs(kind: &str, out: &Path, log: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut files = Vec::new();
    let entries = std::fs::read_dir(out).map_err(|e| format!("/task/out: {e}"))?;
    for e in entries {
        let e = e.map_err(|e| format!("/task/out: {e}"))?;
        let name = e.file_name().to_string_lossy().into_owned();
        let shown = clean_line(&name);
        let meta = std::fs::symlink_metadata(e.path()).map_err(|e| format!("{shown}: {e}"))?;
        if !meta.file_type().is_file() {
            return Err(format!(
                "/task/out/{shown} is not a regular file: nothing was uploaded"
            ));
        }
        let cap = allowed(kind, &name).ok_or_else(|| {
            format!("/task/out/{shown} is not an output a {kind} may upload: nothing was uploaded")
        })?;
        if meta.len() > cap {
            return Err(format!(
                "/task/out/{shown} is {} bytes, above the {kind}'s cap of {cap}: nothing was uploaded",
                meta.len()
            ));
        }
        files.push((name, e.path()));
    }
    if files.len() > 64 {
        return Err(format!(
            "{} files in /task/out, above 64: nothing was uploaded",
            files.len()
        ));
    }
    if let Ok(meta) = std::fs::symlink_metadata(log) {
        if !meta.file_type().is_file() || meta.len() > LOG_CAP + 4096 {
            return Err(
                "the task's log is not the capped file its entrypoint writes: nothing was uploaded"
                    .into(),
            );
        }
    }
    files.sort();
    Ok(files)
}

/// `verdict.json` as the build script writes it.
#[derive(Debug, Default, serde::Deserialize)]
pub struct Verdict {
    #[serde(default)]
    pub status: i32,
    #[serde(default, rename = "final")]
    pub is_final: bool,
    #[serde(default)]
    pub needs_native: bool,
    #[serde(default)]
    pub error: String,
}

fn verdict_of(files: &[(String, PathBuf)]) -> Option<Verdict> {
    let (_, p) = files.iter().find(|(n, _)| n == "verdict.json")?;
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn tail(log: &Path, lines: usize) -> String {
    let text = std::fs::read(log)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

// ---------- reports ----------

/// A report the pool may refuse: refused (4xx — the lease is gone, fenced, or the body
/// wrong) is final and logged; a pool that does not answer is tried again.
fn sent(what: &str, l: &Lease, r: Result<(), RepoError>) -> Result<(), Retry> {
    match r {
        Ok(()) => Ok(()),
        Err(RepoError::Api { status, body }) if (400..500).contains(&status) && status != 429 => {
            crate::work::say(format!(
                "task {}: the pool refused its {what} ({status}: {}); moving on",
                l.task.id,
                clean_line(&body)
            ));
            Ok(())
        }
        Err(e) => Err(Retry(format!("{what}: {}", clean_line(&e.to_string())))),
    }
}

fn report_fail(
    ctx: &Ctx,
    l: &Lease,
    mut body: Value,
    took: u64,
    log: &Path,
) -> Result<String, Retry> {
    if let Some(o) = body.as_object_mut() {
        o.insert("duration_ms".into(), json!(took));
        o.entry("log_tail").or_insert_with(|| json!(tail(log, 80)));
    }
    let error = clean_line(
        body.get("error")
            .and_then(Value::as_str)
            .unwrap_or("failed"),
    );
    sent("failure", l, ctx.pool.fail(l.task.id, &l.token, &body))?;
    Ok(format!("failed — {error}"))
}

fn report_done(
    ctx: &Ctx,
    l: &Lease,
    summary: &str,
    result: &Value,
    took: u64,
    log: &Path,
) -> Result<String, Retry> {
    let field = |k: &str, d: Value| result.get(k).cloned().unwrap_or(d);
    let body = json!({
        "summary": summary, "result": result, "duration_ms": took, "log_tail": tail(log, 80),
        "sha256": field("sha256", json!("-")), "filename": field("filename", json!("-")), "version": field("version", Value::Null),
    });
    sent(
        "completion",
        l,
        ctx.pool.complete(l.task.id, &l.token, &body),
    )?;
    Ok(format!("done — {summary}"))
}

/// An upload to a staging space: refused for good (the quota, 413) fails the task with the
/// pool's words; the lease gone (404, 409) ends it; a pool that does not answer is retried.
enum Upload {
    Ok,
    Refused(String),
    Gone,
}

fn upload(ctx: &Ctx, l: &Lease, to: u64, name: &str, file: &Path) -> Result<Upload, Retry> {
    match ctx.pool.stage(&l.token, to, name, file) {
        Ok(()) => Ok(Upload::Ok),
        Err(RepoError::Api {
            status: 404 | 409, ..
        }) => Ok(Upload::Gone),
        Err(RepoError::Api { status, body }) if (400..500).contains(&status) && status != 429 => {
            Ok(Upload::Refused(format!(
                "{name}: {status} {}",
                clean_line(&body)
            )))
        }
        Err(e) => Err(Retry(format!(
            "uploading {name}: {}",
            clean_line(&e.to_string())
        ))),
    }
}

/// `.PKGINFO` of a package, read with pkg-extract's own archive reader.
fn pkginfo_of(pkg: &Path) -> Option<Vec<u8>> {
    let mut a = tar::Archive::new(pkg_extract::open_archive(pkg).ok()?);
    for e in a.entries().ok()? {
        let mut e = e.ok()?;
        if e.path().ok()?.to_string_lossy() == ".PKGINFO" {
            let mut b = Vec::new();
            e.read_to_end(&mut b).ok()?;
            return Some(b);
        }
    }
    None
}

// ---------- the finish ----------

/// Ends a lease whose container exited: the engine's word first (`OOMKilled`), then the
/// outputs against the kind's list, then the kind's uploads and its report. `Err` when the
/// pool did not answer: the container and the lease stay, and the loop tries again.
pub fn finish(ctx: &Ctx, l: &Lease, state: &State, now: u64) -> Result<String, Retry> {
    let dir = ctx.task_dir(l);
    let out = dir.join("out");
    // The log is read (its tail, an upload) only when it is the regular, capped file the entrypoint
    // writes: a link the task left there could point at anything the dispatcher sees.
    let written = dir.join("log").join("task.log");
    let log = if std::fs::symlink_metadata(&written)
        .is_ok_and(|m| !m.file_type().is_file() || m.len() > LOG_CAP + 4096)
    {
        dir.join("log-refused")
    } else {
        written.clone()
    };
    let took = now.saturating_sub(l.started_at.unwrap_or(l.claimed_at)) * 1000;
    let evidence_to = staging_of(l);
    let (_, mem_gb) = ctx.constants.share(l.units);
    if state.oom_killed {
        if let Some(to) = evidence_to {
            if log.is_file() {
                let _ = upload(ctx, l, to, "build.log", &log)?;
            }
        }
        return report_fail(
            ctx,
            l,
            json!({ "error": format!("the engine killed it at its memory limit ({mem_gb} GB, exit {})", state.exit_code), "oom": true, "final": false }),
            took,
            &log,
        );
    }
    let files = match check_outputs(&l.task.kind, &out, &written) {
        Ok(f) => f,
        Err(why) => return report_fail(ctx, l, fail_body(&why, true), took, &log),
    };
    let verdict = verdict_of(&files);
    if state.exit_code != 0 && verdict.is_none() && matches!(state.exit_code, 137 | 143 | 255) {
        return report_fail(
            ctx,
            l,
            json!({ "error": format!("its container was killed (exit {}) before it ended: a reboot, an engine restart or a kill from outside", state.exit_code), "lost": true, "final": false }),
            took,
            &log,
        );
    }
    match l.task.kind.as_str() {
        "build" => finish_build(ctx, l, state, &files, verdict, took, &log),
        "audit" => finish_audit(ctx, l, state, &files, verdict, took, &log),
        "trial" => finish_trial(ctx, l, state, took, &log),
        other => report_fail(
            ctx,
            l,
            fail_body(&format!("no finish for {other}"), false),
            took,
            &log,
        ),
    }
}

/// Where a build's evidence goes: the task's own staging, for a contributor's build and the project's review rebuild.
fn staging_of(l: &Lease) -> Option<u64> {
    (l.task.kind == "build"
        && (l.task.trust == "community" || l.task.params.get("review").is_some()))
    .then_some(l.task.id)
}

fn failure_of(state: &State, verdict: Option<Verdict>, what: &str) -> Value {
    match verdict {
        Some(v) if v.status != 0 || state.exit_code != 0 => json!({
            "error": if v.error.is_empty() { format!("{what} failed (exit {})", state.exit_code) } else { clean_line(&v.error) },
            "final": v.is_final, "needs_native": v.needs_native,
        }),
        _ => fail_body(
            &format!(
                "{what} failed (exit {}), without a verdict",
                state.exit_code
            ),
            false,
        ),
    }
}

#[allow(clippy::too_many_lines)]
fn finish_build(
    ctx: &Ctx,
    l: &Lease,
    state: &State,
    files: &[(String, PathBuf)],
    verdict: Option<Verdict>,
    took: u64,
    log: &Path,
) -> Result<String, Retry> {
    let t = &l.task;
    let staging = staging_of(l);
    let named = |n: &str| files.iter().find(|(f, _)| f == n).map(|(_, p)| p.clone());
    let evidence: Vec<(&str, PathBuf)> = [
        ("PKGBUILD", named("PKGBUILD")),
        ("build.log", log.is_file().then(|| log.to_path_buf())),
        ("vet.json", named("vet.json")),
        ("tests.log", named("tests.log")),
        ("resources.json", named("resources.json")),
    ]
    .into_iter()
    .filter_map(|(n, p)| p.map(|p| (n, p)))
    .collect();
    let ok = state.exit_code == 0 && verdict.as_ref().is_none_or(|v| v.status == 0);
    if !ok {
        // What there is goes on the record — the log, the gate, the recipe that failed — then the report.
        if let Some(to) = staging {
            for (n, p) in &evidence {
                if let Upload::Gone = upload(ctx, l, to, n, p)? {
                    return Ok("the lease is gone; nothing reported".into());
                }
            }
        }
        return report_fail(ctx, l, failure_of(state, verdict, "the build"), took, log);
    }
    let pkgs: Vec<PathBuf> = files
        .iter()
        .filter(|(n, _)| package_file_ok(n))
        .map(|(_, p)| p.clone())
        .collect();
    if pkgs.is_empty() {
        return report_fail(
            ctx,
            l,
            fail_body(
                "exit 0 without a package: makepkg wrote nothing to /task/out",
                true,
            ),
            took,
            log,
        );
    }
    let main = pkgs
        .iter()
        .find(|p| {
            p.file_name()
                .is_some_and(|f| f.to_string_lossy().starts_with(&format!("{}-", t.name)))
        })
        .unwrap_or(&pkgs[0]);
    let manifest = match pkg_extract::extract_manifest(main) {
        Ok(m) => m,
        Err(e) => {
            return report_fail(
                ctx,
                l,
                fail_body(&format!("the package does not read: {e}"), true),
                took,
                log,
            )
        }
    };
    let result = json!({ "sha256": manifest.sha256, "filename": manifest.filename, "version": manifest.version });
    if let Some(to) = staging {
        // Evidence first, packages last: a workspace at its quota stops where the bytes are (stage_result's order).
        let pkginfo = pkginfo_of(main).and_then(|b| {
            let p = ctx.task_dir(l).join("PKGINFO");
            std::fs::write(&p, b).ok().map(|()| p)
        });
        let mut all: Vec<(String, PathBuf)> = evidence
            .iter()
            .map(|(n, p)| ((*n).to_owned(), p.clone()))
            .collect();
        if let Some(p) = pkginfo {
            all.push(("PKGINFO".into(), p));
        }
        for p in &pkgs {
            all.push((
                p.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                p.clone(),
            ));
        }
        for (n, p) in &all {
            match upload(ctx, l, to, n, p)? {
                Upload::Ok => {}
                Upload::Gone => return Ok("the lease is gone; nothing reported".into()),
                Upload::Refused(why) => {
                    return report_fail(
                        ctx,
                        l,
                        fail_body(&format!("staging: {why}"), true),
                        took,
                        log,
                    )
                }
            }
        }
        let mut result = result;
        let summary = if let Some(from) = t.params.get("review") {
            result["review"] = from.clone();
            format!(
                "{} {} built by the project for {} from staged task {from} — staged for a maintainer's approval",
                manifest.name, manifest.version, t.arch
            )
        } else {
            format!(
                "{} {} built for {} — staged",
                manifest.name, manifest.version, t.arch
            )
        };
        return report_done(ctx, l, &summary, &result, took, log);
    }
    if t.dry_run() {
        // A dry run (#284): built and measured, kept on this host, never published nor rendered.
        let kept = ctx.work_root.join("dry-run").join(format!("task-{}", t.id));
        let _ = std::fs::remove_dir_all(&kept);
        let _ = std::fs::create_dir_all(ctx.work_root.join("dry-run"));
        if let Err(e) = std::fs::rename(ctx.task_dir(l).join("out"), &kept) {
            return Err(Retry(format!("keeping the dry run: {e}")));
        }
        let mut result = result;
        result["dry_run"] = json!(true);
        let summary = format!(
            "{} {} built for {} — a dry run, kept in {}; nothing published",
            manifest.name,
            manifest.version,
            t.arch,
            kept.display()
        );
        return report_done(ctx, l, &summary, &result, took, log);
    }
    // The project's recipe on main: published into edge with the lease's pool:write (the pool signs), both arches rendered.
    let rendered = ctx
        .pool
        .publish(
            &l.token,
            "edge",
            &t.arch,
            &format!("factory task {}: {} ({})", t.id, t.name, t.pkgbuild_ref),
            &pkgs,
            true,
        )
        .map_err(|e| Retry(format!("publishing: {}", clean_line(&format!("{e:#}")))))?;
    let mut result = result;
    result["rendered"] = json!(rendered);
    let summary = format!(
        "{} {} built for {} and published into edge ({})",
        manifest.name,
        manifest.version,
        t.arch,
        rendered.join(", ")
    );
    report_done(ctx, l, &summary, &result, took, log)
}

fn finish_audit(
    ctx: &Ctx,
    l: &Lease,
    state: &State,
    files: &[(String, PathBuf)],
    verdict: Option<Verdict>,
    took: u64,
    log: &Path,
) -> Result<String, Retry> {
    let staged = l
        .notes
        .get("staged")
        .and_then(Value::as_u64)
        .or_else(|| param_task(&l.task.params, "task"));
    let json_at = files
        .iter()
        .find(|(n, _)| n == "audit.json")
        .map(|(_, p)| p.clone());
    let (Some(staged), Some(json_at), 0) = (staged, json_at, state.exit_code) else {
        return report_fail(ctx, l, failure_of(state, verdict, "the audit"), took, log);
    };
    let Ok(report) = serde_json::from_slice::<Value>(&std::fs::read(&json_at).unwrap_or_default())
    else {
        return report_fail(
            ctx,
            l,
            fail_body("audit.json does not read", false),
            took,
            log,
        );
    };
    for (n, p) in files
        .iter()
        .filter(|(n, _)| n == "audit.json" || n == "audit.md")
    {
        match upload(ctx, l, staged, n, p)? {
            Upload::Ok => {}
            Upload::Gone => return Ok("the lease is gone; nothing reported".into()),
            Upload::Refused(why) => {
                return report_fail(
                    ctx,
                    l,
                    fail_body(&format!("attaching {why}"), false),
                    took,
                    log,
                )
            }
        }
    }
    let findings = report
        .get("findings")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let summary = format!(
        "{}: {} ({findings} finding(s), {})",
        s(&report, "verdict"),
        s(&report, "summary"),
        s(&report, "model")
    );
    report_done(ctx, l, &summary, &report, took, log)
}

fn finish_trial(
    ctx: &Ctx,
    l: &Lease,
    state: &State,
    took: u64,
    log: &Path,
) -> Result<String, Retry> {
    let t = &l.task;
    let built = l
        .notes
        .get("built")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let names: Vec<String> = l
        .notes
        .get("packages")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let rendered = l.notes.get("rendered").cloned().unwrap_or(json!([]));
    let out = std::fs::read(log)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let mut verdict = out
        .lines()
        .rev()
        .find_map(|x| x.strip_prefix("TRIAL="))
        .map(|v| {
            v.chars()
                .take_while(|c| c.is_ascii_lowercase() || *c == '-')
                .collect::<String>()
        })
        .filter(|v| !v.is_empty());
    let mut ok = state.exit_code == 0;
    if ok && verdict.is_none() {
        ok = false;
        verdict = Some("did-not-run".into());
    }
    let verdict = verdict.unwrap_or_else(|| if ok { "ok".into() } else { "failed".into() });
    let joined = names.join(",");
    let transcript = ctx.task_dir(l).join("trial.log");
    let header = format!(
        "# trial of task {built} — {joined} on {}, the lab above edge\n",
        t.arch
    );
    if std::fs::write(&transcript, [header.as_bytes(), out.as_bytes()].concat()).is_ok()
        && built > 0
    {
        if let Upload::Gone = upload(ctx, l, built, "trial.log", &transcript)? {
            return Ok("the lease is gone; nothing reported".into());
        }
    }
    let event = json!({
        "kind": "trial", "ring": "lab", "source": t.arch, "status": if ok { "ok" } else { "error" }, "duration_ms": took,
        "summary": if ok { format!("trial of task {built}: {joined} installed on {} from the lab, hooks ran, files verified", t.arch) }
                   else { format!("trial of task {built}: {joined} on {} failed ({verdict})", t.arch) },
        "payload": { "task": built, "arch": t.arch, "packages": joined, "verdict": verdict, "tail": tail(log, 40) },
    });
    if let Err(e) = ctx.pool.post_event(&l.token, &event) {
        crate::work::say(format!(
            "task {}: the trial's event did not reach the pool: {}",
            t.id,
            clean_line(&e.to_string())
        ));
    }
    // A failed trial is a verdict, not a broken job: the task completes with it, as pkg-repo work's did.
    let summary = if ok {
        format!(
            "trial of {} ({}): installed from the lab above edge on {}, hooks ran, files verified",
            t.name,
            names.join(", "),
            t.arch
        )
    } else {
        format!(
            "trial of {} ({}) on {}: {verdict} — see trial.log",
            t.name,
            names.join(", "),
            t.arch
        )
    };
    report_done(
        ctx,
        l,
        &summary,
        &json!({ "verdict": verdict, "packages": names, "task": built, "rendered": rendered }),
        took,
        log,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_outside_the_list_or_above_the_cap_are_refused() {
        let t = tempfile::tempdir().unwrap();
        let out = t.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let log = t.path().join("task.log");
        std::fs::write(out.join("PKGBUILD"), "pkgname=x").unwrap();
        std::fs::write(out.join("felix-1.0-1-aarch64.pkg.tar.zst"), "x").unwrap();
        std::fs::write(out.join("verdict.json"), "{}").unwrap();
        assert_eq!(check_outputs("build", &out, &log).unwrap().len(), 3);
        assert!(
            check_outputs("audit", &out, &log).is_err(),
            "a package is not an audit's output"
        );

        std::fs::write(out.join("evil.sh"), "#!/bin/sh").unwrap();
        let e = check_outputs("build", &out, &log).unwrap_err();
        assert!(
            e.contains("evil.sh") && e.contains("nothing was uploaded"),
            "{e}"
        );
        std::fs::remove_file(out.join("evil.sh")).unwrap();

        std::fs::write(
            out.join("PKGBUILD"),
            vec![b'#'; usize::try_from(MIB).unwrap() + 1],
        )
        .unwrap();
        assert!(check_outputs("build", &out, &log)
            .unwrap_err()
            .contains("above the build's cap"));
        std::fs::write(out.join("PKGBUILD"), "pkgname=x").unwrap();

        std::os::unix::fs::symlink("/etc/passwd", out.join("tests.log")).unwrap();
        assert!(check_outputs("build", &out, &log)
            .unwrap_err()
            .contains("not a regular file"));
        std::fs::remove_file(out.join("tests.log")).unwrap();

        std::fs::create_dir(out.join("vet.json")).unwrap();
        assert!(
            check_outputs("build", &out, &log).is_err(),
            "a directory is not an output"
        );
        std::fs::remove_dir(out.join("vet.json")).unwrap();

        std::os::unix::fs::symlink("/etc/shadow", &log).unwrap();
        assert!(check_outputs("build", &out, &log)
            .unwrap_err()
            .contains("log"));
    }

    #[test]
    fn package_names() {
        assert!(package_file_ok("felix-1.0-1-aarch64.pkg.tar.zst"));
        assert!(package_file_ok("lib32-gtk+3-1:3.24-1-x86_64.pkg.tar.zst"));
        assert!(
            !package_file_ok(".pkg.tar.zst")
                && !package_file_ok("../x.pkg.tar.zst")
                && !package_file_ok("x.pkg.tar.xz")
        );
        assert!(!package_file_ok("a b.pkg.tar.zst"));
    }
}
