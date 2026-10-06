//! The `enqueue` job: reconciles the PKGBUILDs on `main` with what the
//! factory has built. Every (package, architecture, version) under
//! `factory/pkgbuilds/<name>/` without a task yet is queued at that
//! commit. Since 2026-09-17 the repository holds no such recipes — every
//! package is requested on the dashboard and built by the pool — so the
//! job finds nothing and the scheduler no longer runs it; it stays for a
//! maintainer's `pkg-repo job enqueue`, should recipes ever return.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};

use crate::client::Api;
use crate::RepoError;

pub const REPO_URL: &str = "https://github.com/firemanxbr/omarchy-pool";

#[derive(Debug, Default)]
pub struct Report {
    pub commit: String,
    pub queued: Vec<String>,
    pub skipped: Vec<String>,
    pub up_to_date: usize,
}

/// A shallow checkout of `main`, fetched fresh on every run.
fn checkout_main(work_dir: &Path) -> Result<(PathBuf, String)> {
    let dir = work_dir.join("main");
    if dir.join(".git").is_dir() {
        for args in [
            vec!["fetch", "-q", "--depth", "1", "origin", "main"],
            vec!["reset", "-q", "--hard", "FETCH_HEAD"],
        ] {
            let st = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .status()?;
            anyhow::ensure!(st.success(), "git {}", args.join(" "));
        }
    } else {
        let _ = std::fs::remove_dir_all(&dir);
        let st = Command::new("git")
            .args(["clone", "-q", "--depth", "1", "--branch", "main", REPO_URL])
            .arg(&dir)
            .status()
            .context("git clone")?;
        anyhow::ensure!(st.success(), "cloning {REPO_URL}");
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["rev-parse", "HEAD"])
        .output()?;
    Ok((dir, String::from_utf8_lossy(&out.stdout).trim().to_owned()))
}

/// What each PKGBUILD declares, sourced with its functions neutralised in a
/// throwaway container (a bash 4 the host may not have; nothing runs here).
struct Meta {
    name: String,
    arches: Vec<String>,
    version: String,
}

/// The base images the release pins (`tests/images.env`), compiled in: the reader runs the
/// architecture's by digest, the shape a dispatcher's pool job may run (#340).
const IMAGES_ENV: &str = include_str!("../../../tests/images.env");

fn pinned(name: &str) -> Option<&'static str> {
    IMAGES_ENV.lines().find_map(|l| {
        l.strip_prefix(name)
            .and_then(|v| v.strip_prefix('='))
            .map(|v| v.trim().trim_matches('"'))
    })
}

/// The recipes under `factory/pkgbuilds/`, each `<name>/PKGBUILD`, by name.
fn recipes(repo: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(repo.join("factory/pkgbuilds"))
        .map(|d| {
            d.filter_map(Result::ok)
                .filter(|e| e.path().join("PKGBUILD").is_file())
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Copies a recipe's directory (its files and directories, never a link).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = e.file_type()?;
        if t.is_dir() {
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        } else if t.is_file() {
            std::fs::copy(e.path(), to.join(e.file_name()))?;
        }
    }
    Ok(())
}

/// The reader, as it runs inside the container.
const META_SH: &str = r#"set -u; shopt -s expand_aliases nullglob
for f in /repo/pkgbuilds/*/PKGBUILD; do (
  for fn in prepare build check package pkgver; do eval "$fn() { :; }"; done
  source "$f" >/dev/null 2>&1 || true
  d=${f%/PKGBUILD}; d=${d#/repo/pkgbuilds/}
  printf '%s\t%s\t%s\t%s\t%s\n' "$d" "${arch[*]:-}" "${pkgver:-}" "${pkgrel:-1}" "${epoch:-}"
); done
"#;

/// The reader's engine arguments. In a legacy worker's task (the enqueue job, #277): named and
/// labelled with it, and run as the task's child — a stop kills its client's process group and
/// removes the container by its label, as every container a task starts. In a dispatcher's pool
/// job (outside a task's stop) neither: the one shape its `omarchy-task-run` shim takes (#340),
/// which names and labels the helper with the job's lease itself.
fn reader_args(platform: &str, task: Option<u64>, stage: &Path, image: &str) -> Vec<String> {
    let mut a: Vec<String> = ["run", "--rm", "--platform", platform]
        .map(str::to_owned)
        .to_vec();
    if let Some(t) = task {
        a.extend([
            "--name".to_owned(),
            format!("omarchy-task-{t}-meta-{}", std::process::id()),
            "--label".to_owned(),
            format!("{}={t}", crate::stop::TASK_LABEL),
        ]);
    }
    a.extend([
        "-v".to_owned(),
        format!("{}:/repo:ro", stage.display()),
        image.to_owned(),
        "bash".to_owned(),
        "/repo/meta.sh".to_owned(),
    ]);
    a
}

fn pkgbuild_meta(repo: &Path, arch: &str, scratch: &Path) -> Result<Vec<Meta>> {
    // None on main (since 2026-09-17): nothing to read, no container.
    let names = recipes(repo);
    if names.is_empty() {
        return Ok(Vec::new());
    }
    // A dispatcher's pool job names its engine (`RUNTIME`, its omarchy-task-run shim, #340); a worker finds its own.
    let runtime = std::env::var("RUNTIME")
        .ok()
        .filter(|r| !r.trim().is_empty())
        .or_else(|| {
            ["podman", "docker"]
                .iter()
                .find(|r| Command::new(r).arg("--version").output().is_ok())
                .map(|r| (*r).to_owned())
        })
        .ok_or_else(|| anyhow!("podman or docker is required"))?;
    let (image, platform) = if arch == "aarch64" {
        (pinned("ARCHLINUXARM_BASE"), "linux/arm64")
    } else {
        (pinned("ARCHLINUX_BASE"), "linux/amd64")
    };
    let image = image.ok_or_else(|| anyhow!("tests/images.env pins no base image for {arch}"))?;
    // The recipes and the reader, staged in a scratch directory of their own (the worker's, the
    // same path on its host): mounted read-only at /repo, run with bash — the one shape a pool
    // job's helper takes (#340).
    let stage = scratch.join(format!(
        "meta.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    let _ = std::fs::remove_dir_all(&stage);
    for n in &names {
        copy_tree(
            &repo.join("factory/pkgbuilds").join(n),
            &stage.join("pkgbuilds").join(n),
        )
        .with_context(|| format!("staging the recipe of {n}"))?;
    }
    std::fs::write(stage.join("meta.sh"), META_SH)?;
    let task = crate::stop::current();
    let mut cmd = Command::new(&runtime);
    cmd.args(reader_args(
        platform,
        task.as_ref().map(|t| t.task()),
        &stage,
        image,
    ));
    let out = if task.is_some() {
        crate::stop::output(&mut cmd)
    } else {
        cmd.output()
    }
    .context("reading the PKGBUILDs in a container");
    let _ = std::fs::remove_dir_all(&stage);
    let out = out?;
    crate::stop::check()?;
    anyhow::ensure!(
        out.status.success(),
        "pkgbuild meta: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let mut metas = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 5 || f[2].is_empty() {
            continue;
        }
        let name = f[0];
        if name.is_empty() || name.contains('/') {
            continue;
        }
        let mut arches: Vec<String> = Vec::new();
        for a in f[1].split_whitespace() {
            match a {
                "any" => {
                    arches = vec!["x86_64".into(), "aarch64".into()];
                    break;
                }
                "x86_64" | "aarch64" => arches.push(a.to_owned()),
                _ => {}
            }
        }
        let version = if f[4].is_empty() {
            format!("{}-{}", f[2], f[3])
        } else {
            format!("{}:{}-{}", f[4], f[2], f[3])
        };
        metas.push(Meta {
            name: name.to_owned(),
            arches,
            version,
        });
    }
    Ok(metas)
}

/// Queues, at the current `main`, every PKGBUILD version the factory has no task for.
pub fn run(api: &Api, work_dir: &Path, arch: &str, scratch: &Path) -> Result<Report> {
    let (repo, commit) = checkout_main(work_dir)?;
    let built = api.get_json("/factory/built")?;
    let have: HashSet<(String, String, String)> = built["built"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    Some((
                        r["name"].as_str()?.to_owned(),
                        r["version"].as_str()?.to_owned(),
                        r["arch"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut report = Report {
        commit: commit.clone(),
        ..Report::default()
    };
    std::fs::create_dir_all(scratch)?;
    for m in pkgbuild_meta(&repo, arch, scratch)? {
        let missing: Vec<&String> = m
            .arches
            .iter()
            .filter(|a| !have.contains(&(m.name.clone(), m.version.clone(), (*a).clone())))
            .collect();
        if missing.is_empty() {
            report.up_to_date += 1;
            continue;
        }
        let body = serde_json::json!({
            "name": m.name, "pkgbuild_ref": commit, "version": m.version,
            "arches": missing, "reason": "pkgbuild-changed", "publish": true,
        });
        match api.post_json("/factory/enqueue", &body) {
            Ok(_) => {
                report.queued.push(format!(
                    "{} {} ({})",
                    m.name,
                    m.version,
                    missing
                        .iter()
                        .map(|a| a.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            Err(RepoError::Api { status: 409, body }) => {
                report.skipped.push(format!("{}: {}", m.name, body.trim()));
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reader_runs_the_pinned_base_image_of_each_arch_and_nothing_when_main_has_no_recipe() {
        for (name, arch) in [
            ("ARCHLINUX_BASE", "archlinux:base@sha256:"),
            ("ARCHLINUXARM_BASE", "archlinuxarm:base@sha256:"),
        ] {
            let image = pinned(name).unwrap();
            assert!(
                image.contains(arch) && crate::dispatch::spec::digest_ok(image),
                "{image}"
            );
        }
        // No recipe on main: no container at all (an engine that is not there is never looked for).
        let t = tempfile::tempdir().unwrap();
        assert!(pkgbuild_meta(t.path(), "x86_64", &t.path().join("tmp"))
            .unwrap()
            .is_empty());
        std::fs::create_dir_all(t.path().join("factory/pkgbuilds/felix")).unwrap();
        std::fs::create_dir_all(t.path().join("factory/pkgbuilds/no-recipe")).unwrap();
        std::fs::write(
            t.path().join("factory/pkgbuilds/felix/PKGBUILD"),
            "pkgname=felix\n",
        )
        .unwrap();
        assert_eq!(recipes(t.path()), ["felix"]);
        // The reader's directory, as the shim takes it: a script of its own, the recipes beside it.
        let stage = t.path().join("stage");
        copy_tree(
            &t.path().join("factory/pkgbuilds/felix"),
            &stage.join("pkgbuilds/felix"),
        )
        .unwrap();
        assert!(stage.join("pkgbuilds/felix/PKGBUILD").is_file());
        assert!(
            META_SH.contains("/repo/pkgbuilds/*/PKGBUILD") && META_SH.contains("printf '%s\\t")
        );
    }

    /// A dispatcher's enqueue (#340) runs the reader through its `omarchy-task-run` shim, which
    /// takes only its one shape: the reader's arguments outside a task are that shape, for both
    /// arches; a legacy worker's (inside a task's stop) name and label its container, which the
    /// shim would refuse — and never meets.
    #[test]
    fn the_readers_run_is_the_one_shape_the_shim_takes() {
        use crate::dispatch::shim;
        let stage = Path::new("/w/tasks/9-g_0123456789abcdef/tmp/meta.123.456");
        // A directory directly under the job's scratch, as the shim wants it: `meta.<pid>.<ns>`.
        assert!(crate::dispatch::spec::scratch_name_ok(&format!(
            "meta.{}.{}",
            u32::MAX,
            u128::from(u64::MAX)
        )));
        for (platform, name, arch) in [
            ("linux/amd64", "ARCHLINUX_BASE", "x86_64"),
            ("linux/arm64", "ARCHLINUXARM_BASE", "aarch64"),
        ] {
            let image = pinned(name).unwrap();
            let run = shim::parse(&reader_args(platform, None, stage, image)).unwrap();
            assert_eq!(
                run,
                shim::Run {
                    arch: arch.into(),
                    keyring: None,
                    dir: stage.to_path_buf(),
                    read_only: true,
                    image: image.into(),
                    script: "meta.sh".into(),
                }
            );
        }
        let legacy = reader_args(
            "linux/amd64",
            Some(9),
            stage,
            pinned("ARCHLINUX_BASE").unwrap(),
        );
        assert!(legacy.contains(&format!("{}=9", crate::stop::TASK_LABEL)));
        assert!(shim::parse(&legacy).is_err());
    }
}
