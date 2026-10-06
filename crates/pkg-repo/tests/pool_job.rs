//! `pkg-repo pool-job` (#340, design v2 §9.2), the child a dispatcher starts for each pool job: the
//! built binary run on a job directory as the dispatcher writes it, its script a stub that writes
//! down what it was given. The dispatcher's own tests start a shell in its place (`FakeLaunch`);
//! this is the child itself — its 2 GB memory limit, the job token it reads from its directory,
//! its scripts' scratch, and the `result.json` its dispatcher reports from.

use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};

/// A health check's job directory: `job.json` and `token`, its release checkout a stub
/// `tests/health-check.sh` running `body`.
fn job_dir(root: &Path, body: &str) -> std::path::PathBuf {
    let (dir, repo, work) = (root.join("task"), root.join("release"), root.join("work"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(repo.join("tests")).unwrap();
    std::fs::write(repo.join("tests/health-check.sh"), body).unwrap();
    let spec = json!({
        "task": { "id": 50, "kind": "health", "name": "health", "arch": "x86_64", "trust": "project",
                  "params": { "ring": "rc", "arch": "x86_64" } },
        // Nothing listens there: a health check posts nothing itself, its script does.
        "api": "http://127.0.0.1:9/api/v1",
        "pool": "http://127.0.0.1:9",
        "arch": "aarch64",
        "work_dir": work,
        "repo_dir": repo,
        "scratch": dir.join("tmp"),
    });
    std::fs::write(dir.join("job.json"), spec.to_string()).unwrap();
    std::fs::write(dir.join("token"), "omj.the-lease-token\n").unwrap();
    dir
}

fn run(dir: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_pkg-repo"))
        .args(["pool-job", "--dir"])
        .arg(dir)
        // What the dispatcher removes from a job's environment: never what its script gets.
        .env("OMARCHY_TOKEN", "omj.stale")
        .env_remove("OMARCHY_TASK_ID")
        .output()
        .unwrap()
}

fn result(dir: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join("result.json")).unwrap()).unwrap()
}

#[test]
fn a_pool_jobs_child_runs_under_its_2_gb_limit_with_its_leases_token_and_writes_its_result() {
    let t = tempfile::tempdir().unwrap();
    let out = t.path().join("seen");
    let dir = job_dir(
        t.path(),
        &format!(
            "{{ echo \"data=$(ulimit -d)\"; grep '^Max data size' /proc/self/limits; echo \"token=$OMARCHY_TOKEN\"; echo \"tmp=$TMPDIR\"; echo \"args=$*\"; }} > {}\n",
            out.display()
        ),
    );
    let o = run(&dir);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let seen = std::fs::read_to_string(&out).unwrap();
    let line = |k: &str| {
        seen.lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")))
            .unwrap_or_default()
            .to_owned()
    };
    // Its data rlimit, set on itself before anything ran, inherited by its scripts: 2 GiB, soft and hard.
    assert_eq!(line("data"), "2097152", "{seen}");
    let limits: Vec<&str> = seen
        .lines()
        .find(|l| l.starts_with("Max data size"))
        .unwrap()
        .split_whitespace()
        .collect();
    assert_eq!(limits[3..5], ["2147483648", "2147483648"], "{seen}");
    // The token is the lease's, from its directory — never one in the dispatcher's environment.
    assert_eq!(line("token"), "omj.the-lease-token");
    assert_eq!(line("tmp"), dir.join("tmp").display().to_string());
    assert_eq!(line("args"), "rc x86_64");
    let r = result(&dir);
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["summary"], "rc/x86_64 healthy");
    assert_eq!(r["result"], json!({ "ok": true }));
    assert!(r["duration_ms"].is_u64());
    let mode = std::os::unix::fs::PermissionsExt::mode(
        &std::fs::metadata(dir.join("result.json"))
            .unwrap()
            .permissions(),
    );
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_job_that_fails_writes_its_failure_and_one_without_a_token_runs_nothing() {
    let t = tempfile::tempdir().unwrap();
    let dir = job_dir(t.path(), "exit 1\n");
    let o = run(&dir);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let r = result(&dir);
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["fail"]["final"], false);
    assert!(
        r["fail"]["error"]
            .as_str()
            .unwrap()
            .contains("health check of rc/x86_64 failed"),
        "{r}"
    );
    // No token in its directory: it never starts the job (nor writes a result its dispatcher would report).
    let t = tempfile::tempdir().unwrap();
    let ran = t.path().join("ran");
    let dir = job_dir(t.path(), &format!("touch {}\n", ran.display()));
    std::fs::write(dir.join("token"), "").unwrap();
    let o = run(&dir);
    assert!(!o.status.success());
    assert!(!ran.exists() && !dir.join("result.json").exists());
}
