//! `omarchy-task-run` (#340, design v2 §9.2, §10.3; D34): the only engine a
//! pool job's scripts reach. A pool job runs in the dispatcher (signed
//! release code, with its job token), but the checks its scripts start —
//! `tests/health-check.sh`'s pacman, the ABI gate's references, which install
//! a ring's packages and run their hooks — run package code, so they go
//! through the one spec as every task container does.
//!
//! The dispatcher starts a job's process with `RUNTIME` set to this shim and
//! the shim first on `PATH` as `docker` and `podman` too, so a script that
//! looks its engine up by name finds it as well. The shim reads its `run`:
//!
//! ```text
//! run --rm --platform linux/<amd64|arm64> [-e KEYRING=<keyring>] -v <dir>:/repo[:ro] <image@sha256:…> bash /repo/<script>.sh
//! ```
//!
//! — the shape `tests/health-check.sh`, `tests/trial.sh`, `tests/abi-gate.sh`,
//! `tests/omarchy-rootfs.sh` and the enqueue's PKGBUILD reader (`reconcile.rs`)
//! use, its flags in any order, each once — and
//! refuses anything else (another verb, flag, mount, variable or command)
//! before any engine call, with the engine CLI's own code for a `run` it
//! could not start (125). What it accepts must also fit the job: an
//! architecture this host runs a lane of, an image the release pins in
//! `tests/images.env`, a directory directly under the job's own scratch
//! directory (its scripts' `TMPDIR`, never the job's directory that holds
//! its token). Then [`spec::helper_plan`] makes the rest: the job's own
//! internal network on its /28 and its egress sidecar, the job's share, the
//! task container's capabilities, no token and no socket. The helper runs
//! attached, so its output and its exit code reach the script; it is
//! removed with the network and the sidecar when it ends, and whatever a
//! killed shim leaves goes when its job ends (the dispatcher removes every
//! container labelled with the lease).
//!
//! The job's context (`helper.json`, named by `OMARCHY_TASK_RUN`) is written
//! by the dispatcher in the job's directory before the job starts: the
//! lease, its /28, the lanes, the release's pinned images, the real engine.
//! A job of a kind that starts no helper (a sync, a render) has none, and
//! its every engine call is refused.
//!
//! **On a remapped daemon** (#405, #407) a helper's root is the remapped
//! range's first uid on the host, as a task container's is, and "other" on the
//! directory its script made (`mktemp -d`: 0700, the dispatcher's root): it
//! could not even read `/repo/<script>.sh`. The context carries that root
//! (`task_root`, what the engine told the dispatcher at its start), and before
//! the helper starts the shim opens its directory to it ([`open_for`]):
//! mounted read-only, for reading, as a task's `in` is — every directory 0755,
//! every regular file `a+r`, a link left as it is; mounted read-write, the
//! directory itself given to that root, as a task's writable directories are
//! (never opened to every user), and what the script put in it opened for
//! reading. A run whose directory it cannot open is refused (125) before
//! its network, its sidecar or the helper is started. Nothing is given back
//! after: the job reads and removes what its helper wrote as it always did
//! (root, with docker's default capabilities), and the job's 0700 directory
//! holds it all. On every other engine there is no task root and nothing
//! changes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::engine::{self, Engine as _, TaskRoot};
use super::spec::{self, Gateway, Subnets};

/// Its name on `PATH`, and what `RUNTIME` names.
pub const NAME: &str = "omarchy-task-run";
/// The variable naming the job's context file.
pub const CONTEXT_VAR: &str = "OMARCHY_TASK_RUN";
/// What a refused `run` exits with: the engine CLI's code for a `run` it could not start.
pub const REFUSED: i32 = 125;

/// The one shape, as the refusal says it.
pub const SHAPE: &str = "run --rm --platform linux/<amd64|arm64> [-e KEYRING=<keyring>] -v <a scratch directory of this job>:/repo[:ro] <image@sha256:…> bash /repo/<script>.sh";

/// What a script's `run` asked for, once read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub arch: String,
    pub keyring: Option<String>,
    pub dir: PathBuf,
    pub read_only: bool,
    pub image: String,
    pub script: String,
}

/// Reads a script's engine arguments (after the engine's name): the one shape, or why not.
pub fn parse(args: &[String]) -> Result<Run, String> {
    let mut it = args.iter().map(String::as_str).peekable();
    match it.next() {
        Some("run") => {}
        Some(v) => return Err(format!("`{v}`: only `run` is taken")),
        None => return Err("no arguments".into()),
    }
    let (mut rm, mut platform, mut keyring, mut volume) = (false, None, None, None);
    let once = |slot: &mut Option<String>, flag: &str, v: Option<&str>| -> Result<(), String> {
        let v = v.ok_or_else(|| format!("{flag} without a value"))?;
        if slot.replace(v.to_owned()).is_some() {
            return Err(format!("{flag} twice"));
        }
        Ok(())
    };
    while let Some(&f) = it.peek() {
        if !f.starts_with('-') {
            break;
        }
        it.next();
        match f {
            "--rm" if !rm => rm = true,
            "--platform" => once(&mut platform, f, it.next())?,
            "-e" => once(&mut keyring, f, it.next())?,
            "-v" => once(&mut volume, f, it.next())?,
            other => return Err(format!("{other}: a flag outside the shape")),
        }
    }
    if !rm {
        return Err("no --rm: the scripts' helpers are one-shot".into());
    }
    let platform = platform.ok_or("no --platform")?;
    let arch = match platform.as_str() {
        "linux/amd64" => "x86_64",
        "linux/arm64" => "aarch64",
        p => return Err(format!("platform {p:?} is not a lane's")),
    }
    .to_owned();
    let keyring = match keyring {
        None => None,
        Some(e) => {
            let k = e
                .strip_prefix(&format!("{}=", spec::HELPER_ENV))
                .ok_or_else(|| format!("-e {e}: only {}=<keyring> is passed", spec::HELPER_ENV))?;
            if !spec::HELPER_KEYRINGS.contains(&k) {
                return Err(format!(
                    "keyring {k:?} is not a base image's ({})",
                    spec::HELPER_KEYRINGS.join(", ")
                ));
            }
            Some(k.to_owned())
        }
    };
    let volume = volume.ok_or("no -v <dir>:/repo")?;
    let (dir, read_only) = if let Some(d) = volume.strip_suffix(":/repo:ro") {
        (d, true)
    } else if let Some(d) = volume.strip_suffix(":/repo") {
        (d, false)
    } else {
        return Err(format!("-v {volume}: only <dir>:/repo or <dir>:/repo:ro"));
    };
    let image = it.next().ok_or("no image")?.to_owned();
    if !spec::digest_ok(&image) {
        return Err(format!("image {image:?} is not pinned by digest"));
    }
    let rest: Vec<&str> = it.collect();
    let script = match rest.as_slice() {
        ["bash", s] => s
            .strip_prefix("/repo/")
            .filter(|n| spec::script_ok(n))
            .ok_or_else(|| format!("bash {s}: only bash /repo/<script>.sh"))?,
        other => {
            return Err(format!(
                "command {:?}: only bash /repo/<script>.sh",
                other.join(" ")
            ))
        }
    }
    .to_owned();
    Ok(Run {
        arch,
        keyring,
        dir: PathBuf::from(dir),
        read_only,
        image,
        script,
    })
}

/// What the dispatcher tells the shim of a job that starts helpers (`helper.json`, #340).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Context {
    pub task: u64,
    pub gen: String,
    pub host: String,
    /// The job's scratch root (`<task dir>/tmp`): every helper mounts a directory directly under it.
    pub scratch: PathBuf,
    /// The architectures this host runs a lane of now, native or emulated.
    pub arches: Vec<String>,
    /// The images the release pins (`tests/images.env`): no other runs.
    pub images: Vec<String>,
    /// The job's units: the helper's share, less its egress sidecar's.
    pub units: u32,
    pub unit_cpus: u32,
    pub unit_mem_gb: u32,
    pub worker_image: String,
    /// `OMARCHY_TASK_SUBNETS`, and the job's /28 of it.
    pub subnets: String,
    pub slot: u32,
    /// The host's own addresses, which the egress refuses.
    pub deny: Vec<String>,
    /// The engine itself: its CLI by absolute path, never this shim.
    pub engine: PathBuf,
    /// A remapped daemon's task root as the host sees it (#405, [`engine::Cli::remap`]), which a
    /// helper's root is too: its directory is opened to it before it starts ([`open_for`], #407).
    /// None on every other engine, and in a context that does not name one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_root: Option<TaskRoot>,
}

/// Checks a read `run` against the job: its lane, its image, its directory.
pub fn fits(run: &Run, ctx: &Context) -> Result<(), String> {
    if !ctx.arches.contains(&run.arch) {
        return Err(format!(
            "this host runs no lane of {} (its lanes: {})",
            run.arch,
            ctx.arches.join(", ")
        ));
    }
    if !ctx.images.contains(&run.image) {
        return Err(format!(
            "{} is not an image the release pins (tests/images.env)",
            run.image
        ));
    }
    // The directory the script made itself (mktemp -d), directly under the job's scratch root:
    // a real directory, never a link to somewhere else.
    if run.dir.parent() != Some(ctx.scratch.as_path()) {
        return Err(format!(
            "{} is not directly under this job's scratch directory {}",
            run.dir.display(),
            ctx.scratch.display()
        ));
    }
    match std::fs::symlink_metadata(&run.dir) {
        Ok(m) if m.file_type().is_dir() => {}
        _ => return Err(format!("{} is not a directory", run.dir.display())),
    }
    if !std::fs::symlink_metadata(run.dir.join(&run.script)).is_ok_and(|m| m.file_type().is_file())
    {
        return Err(format!(
            "{} has no {} to run",
            run.dir.display(),
            run.script
        ));
    }
    Ok(())
}

/// A helper's directory opened to a remapped daemon's task root `root` (#407), which is "other"
/// on what the job made. Mounted read-only, it is opened for reading as a task's `in` is
/// ([`super::kinds::open_input`]): every directory 0755, every regular file `a+r` with its other
/// bits kept, walked without following a link. Mounted read-write, the directory itself is given
/// to that root (`lchown`, as a task's [`super::kinds::WRITABLE`] directories are: never opened
/// to every user, where another uid could plant what the job reads back) and what the script put
/// in it opened for reading; what the helper writes there is its root's. Nothing outside the
/// directory changes, and nothing is given back after: the job reads and removes what its helper
/// wrote, as root, as before. An error names the directory as the helper sees it (`/repo`).
pub fn open_for(run: &Run, root: TaskRoot) -> std::io::Result<()> {
    let shown = Path::new("/repo");
    if run.read_only {
        return super::kinds::open_readable(&run.dir, shown);
    }
    std::os::unix::fs::lchown(&run.dir, Some(root.uid), Some(root.gid))
        .map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", shown.display())))?;
    super::kinds::open_within(&run.dir, shown)
}

/// The helper's plan: the job's network and egress sidecar, then its own `run` — on this engine's
/// way of keeping a network's gateway off the host, as the engine itself says it.
pub fn plan_of(
    run: &Run,
    ctx: &Context,
    gateway: Gateway,
) -> Result<(Vec<Vec<String>>, Vec<String>), String> {
    let subnets = Subnets::parse(&ctx.subnets)?;
    let units = ctx.units.max(1);
    spec::helper_plan(&spec::Helper {
        task: ctx.task,
        gen: &ctx.gen,
        host: &ctx.host,
        arch: &run.arch,
        image: &run.image,
        dir: &run.dir,
        scratch: &ctx.scratch,
        read_only: run.read_only,
        script: &run.script,
        keyring: run.keyring.as_deref(),
        cpus: units * ctx.unit_cpus,
        mem_gb: units * ctx.unit_mem_gb,
        worker_image: &ctx.worker_image,
        subnets,
        slot: ctx.slot,
        gateway,
        deny: &ctx.deny,
    })
}

fn refuse(why: &str) -> i32 {
    eprintln!("{NAME}: refused — {why}; a pool job's helper runs only as `{SHAPE}`");
    REFUSED
}

/// `pkg-repo task-run <args…>`, as `omarchy-task-run`: the helper's exit code, or 125.
pub fn main(args: &[String]) -> i32 {
    run_with(
        std::env::var_os(CONTEXT_VAR).map(PathBuf::from).as_deref(),
        args,
    )
}

/// [`main`] with the job's context file named: the helper's exit code, or 125.
pub fn run_with(context: Option<&Path>, args: &[String]) -> i32 {
    let ctx = match context {
        Some(p) => match std::fs::read(p)
            .ok()
            .and_then(|b| serde_json::from_slice::<Context>(&b).ok())
        {
            Some(c) => c,
            None => return refuse("this job's helper context does not read"),
        },
        None => return refuse("this process starts no helper containers (no job's context: only a pool job of a kind that checks a ring has one)"),
    };
    let run = match parse(args) {
        Ok(r) => r,
        Err(why) => return refuse(&why),
    };
    if let Err(why) = fits(&run, &ctx) {
        return refuse(&why);
    }
    // The engine itself, by its path, as the dispatcher asks it at its start: how it keeps a network's
    // gateway off the host (behind docker's CLI, podman's networks through libpod's API, #372).
    let mut engine = engine::Cli {
        runtime: ctx.engine.display().to_string(),
        libpod: None,
    };
    let gateway = match engine.gateway() {
        Ok(g) => g,
        Err(why) => {
            eprintln!("{NAME}: the engine did not say how it keeps a network's gateway off the host: {why}");
            return REFUSED;
        }
    };
    let (setup, helper) = match plan_of(&run, &ctx, gateway) {
        Ok(p) => p,
        Err(why) => return refuse(&why),
    };
    // On a remapped daemon (#405) the helper's root is "other" on the directory its script made
    // (#407): opened to it once the run is taken, before anything of it starts, or nothing does.
    if let Some(root) = ctx.task_root {
        if let Err(e) = open_for(&run, root) {
            eprintln!(
                "{NAME}: {} could not be opened to the remapped task root {}:{}: {e}",
                run.dir.display(),
                root.uid,
                root.gid
            );
            return REFUSED;
        }
    }
    // What an earlier helper of this job left (a shim killed half-way): the lease's network would be in the way.
    engine.remove_lease(ctx.task, &ctx.gen);
    let ready = engine::ensure_bridge(&engine, &ctx.host).and_then(|()| {
        setup
            .iter()
            .try_for_each(|c| engine.run(c).map_err(|e| crate::orders::clean_line(&e)))
    });
    let code = match ready {
        Err(why) => {
            eprintln!("{NAME}: the helper's network or egress sidecar did not start: {why}");
            REFUSED
        }
        Ok(()) => std::process::Command::new(&ctx.engine)
            .args(&helper)
            .stdin(std::process::Stdio::null())
            .status()
            .map_or(REFUSED, |s| {
                use std::os::unix::process::ExitStatusExt as _;
                s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0))
            }),
    };
    engine.remove_lease(ctx.task, &ctx.gen);
    code
}

/// The release's pinned images, as `tests/images.env` writes them (`NAME="<image>@sha256:…"`).
pub fn pinned_images(checkout: &Path) -> Vec<String> {
    std::fs::read_to_string(checkout.join("tests/images.env"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(_, v)| v.trim().trim_matches('"').to_owned())
        .filter(|v| spec::digest_ok(v))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARCH_BASE: &str = "docker.io/library/archlinux:base@sha256:b944cc65c5f28665dfd5fdbf5ed2997c88f5bb4a0aefac7ee8a7ef01893e5ed9";
    const ALARM_BASE: &str = "docker.io/menci/archlinuxarm:base@sha256:2087760148b21cdabf265a83e075aca2c0c2e6466eb04de6cf1adcecf362e943";

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn the_shapes_the_scripts_use_are_taken() {
        // tests/health-check.sh and tests/trial.sh, as a pool job runs them (no OMARCHY_TASK_ID: no --name, no --label).
        let check = parse(&argv(&format!(
            "run --rm --platform linux/amd64 -e KEYRING=archlinux -v /w/tasks/9-g_0123456789abcdef/tmp/tmp.AbC123:/repo:ro {ARCH_BASE} bash /repo/check.sh"
        )))
        .unwrap();
        assert_eq!(
            check,
            Run {
                arch: "x86_64".into(),
                keyring: Some("archlinux".into()),
                dir: PathBuf::from("/w/tasks/9-g_0123456789abcdef/tmp/tmp.AbC123"),
                read_only: true,
                image: ARCH_BASE.into(),
                script: "check.sh".into(),
            }
        );
        // tests/omarchy-rootfs.sh's install and tests/abi-gate.sh's export: their directory writable, no keyring.
        let build = parse(&argv(&format!(
            "run --rm --platform linux/amd64 -v /w/t/tmp/tmp.x:/repo {ARCH_BASE} bash /repo/build.sh"
        )))
        .unwrap();
        assert!(!build.read_only && build.keyring.is_none() && build.script == "build.sh");
        let export = parse(&argv(&format!(
            "run --rm --platform linux/arm64 -v /w/t/tmp/tmp.y:/repo {ALARM_BASE} bash /repo/export.sh"
        )))
        .unwrap();
        assert_eq!(export.arch, "aarch64");
        // The enqueue's PKGBUILD reader (reconcile.rs): its staged recipes read-only, no keyring.
        let meta = parse(&argv(&format!(
            "run --rm --platform linux/arm64 -v /w/tasks/9-g_0123456789abcdef/tmp/meta.123.456:/repo:ro {ALARM_BASE} bash /repo/meta.sh"
        )))
        .unwrap();
        assert!(meta.read_only && meta.keyring.is_none() && meta.script == "meta.sh");
        // Its flags in any order.
        assert!(parse(&argv(&format!(
            "run -v /w/t/tmp/x:/repo:ro --platform linux/arm64 --rm -e KEYRING=archlinuxarm {ALARM_BASE} bash /repo/check.sh"
        )))
        .is_ok());
    }

    #[test]
    fn every_other_shape_is_refused() {
        let ok = format!("run --rm --platform linux/amd64 -e KEYRING=archlinux -v /w/t/tmp/x:/repo:ro {ARCH_BASE} bash /repo/check.sh");
        assert!(parse(&argv(&ok)).is_ok());
        let refused = [
            // Other verbs: what the ABI gate's reference did before (#340), and the engine's reach.
            format!("create --platform linux/amd64 {ARCH_BASE} true"),
            "export 0123456789ab".to_owned(),
            "rm 0123456789ab".to_owned(),
            "ps -a".to_owned(),
            "exec -it x sh".to_owned(),
            "pull alpine".to_owned(),
            "network create x".to_owned(),
            "--version".to_owned(),
            String::new(),
            // A run with anything more, less or else.
            ok.replace("run --rm", "run -d"),
            ok.replace("run --rm", "run"),
            ok.replace("--rm", "--rm --rm"),
            ok.replace("--rm", "--rm --privileged"),
            ok.replace("--rm", "--rm --network host"),
            ok.replace("--rm", "--rm --name omarchy-task-9-check-1"),
            ok.replace("--rm", "--rm --label com.omarchy.task=9"),
            ok.replace("--rm", "--rm --cap-add SYS_ADMIN"),
            ok.replace("--rm", "--rm --user 0"),
            ok.replace("--rm", "--rm --entrypoint sh"),
            ok.replace("--rm", "--rm --device /dev/kvm"),
            ok.replace("--rm", "--rm --mount type=bind,source=/,target=/h"),
            ok.replace("--rm", "--rm -v /var/run/docker.sock:/var/run/docker.sock"),
            ok.replace("--rm", "--rm -e OMARCHY_TOKEN=omj.x"),
            ok.replace("--rm", "--rm --platform=linux/amd64"),
            ok.replace(" --platform linux/amd64", ""),
            ok.replace("linux/amd64", "linux/riscv64"),
            ok.replace("KEYRING=archlinux", "OMARCHY_TOKEN=omj.x"),
            ok.replace("KEYRING=archlinux", "KEYRING=../x"),
            ok.replace(":/repo:ro", ":/"),
            ok.replace(":/repo:ro", ":/repo:rw"),
            ok.replace(":/repo:ro", ":/var/run/docker.sock"),
            ok.replace(" -v /w/t/tmp/x:/repo:ro", ""),
            ok.replace(ARCH_BASE, "docker.io/library/archlinux:base"),
            ok.replace("bash /repo/check.sh", "sh /repo/check.sh"),
            ok.replace("bash /repo/check.sh", "bash -c id"),
            ok.replace("bash /repo/check.sh", "bash /repo/../check.sh"),
            ok.replace("bash /repo/check.sh", "bash /etc/check.sh"),
            ok.replace("bash /repo/check.sh", "bash /repo/check.sh --more"),
            ok.replace("bash /repo/check.sh", ""),
        ];
        for r in refused {
            assert!(parse(&argv(&r)).is_err(), "must be refused: {r}");
        }
    }

    fn ctx(scratch: &Path) -> Context {
        Context {
            task: 9,
            gen: "g_0123456789abcdef".into(),
            host: "h_studio-1".into(),
            scratch: scratch.to_path_buf(),
            arches: vec!["aarch64".into(), "x86_64".into()],
            images: vec![ARCH_BASE.into(), ALARM_BASE.into()],
            units: 1,
            unit_cpus: 1,
            unit_mem_gb: 2,
            worker_image: "ghcr.io/firemanxbr/omarchy-worker@sha256:1111111111111111111111111111111111111111111111111111111111111111".into(),
            subnets: "10.231.0.0/16".into(),
            slot: 3,
            deny: Vec::new(),
            engine: PathBuf::from("/usr/bin/docker"),
            task_root: None,
        }
    }

    #[test]
    fn a_run_must_fit_its_job_its_lanes_its_images_and_its_scratch() {
        let t = tempfile::tempdir().unwrap();
        let scratch = t.path().canonicalize().unwrap().join("tmp");
        let dir = scratch.join("tmp.AbC123");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("check.sh"), "true\n").unwrap();
        let c = ctx(&scratch);
        let run = |s: &str| parse(&argv(s)).unwrap();
        let good = run(&format!(
            "run --rm --platform linux/amd64 -v {}:/repo:ro {ARCH_BASE} bash /repo/check.sh",
            dir.display()
        ));
        fits(&good, &c).unwrap();
        let (setup, helper) = plan_of(&good, &c, Gateway::Isolated).unwrap();
        assert_eq!(setup[0][..3], ["network", "create", "--internal"]);
        let (podman, _) = plan_of(&good, &c, Gateway::NoDns).unwrap();
        assert!(podman[0].iter().any(|a| a == "--disable-dns"), "{podman:?}");
        assert_eq!(
            helper[..3],
            ["run", "--name", "omarchy-task-9-g_0123456789abcdef-helper"]
        );
        // A lane this host does not run.
        let only_arm = Context {
            arches: vec!["aarch64".into()],
            ..c.clone()
        };
        assert!(fits(&good, &only_arm)
            .unwrap_err()
            .contains("no lane of x86_64"));
        // An image the release does not pin, though by digest.
        let other = run(&format!(
            "run --rm --platform linux/amd64 -v {}:/repo:ro docker.io/library/debian@sha256:{} bash /repo/check.sh",
            dir.display(),
            "a".repeat(64)
        ));
        assert!(fits(&other, &c).unwrap_err().contains("pins"));
        // A directory outside its scratch: the job's own directory (its token), deeper, a link, none.
        let job_dir = run(&format!(
            "run --rm --platform linux/amd64 -v {}:/repo:ro {ARCH_BASE} bash /repo/check.sh",
            t.path().canonicalize().unwrap().display()
        ));
        assert!(fits(&job_dir, &c).is_err());
        std::fs::create_dir_all(dir.join("deeper")).unwrap();
        let deeper = run(&format!(
            "run --rm --platform linux/amd64 -v {}:/repo:ro {ARCH_BASE} bash /repo/check.sh",
            dir.join("deeper").display()
        ));
        assert!(fits(&deeper, &c).is_err());
        std::os::unix::fs::symlink("/", scratch.join("tmp.link")).unwrap();
        let link = run(&format!(
            "run --rm --platform linux/amd64 -v {}:/repo:ro {ARCH_BASE} bash /repo/check.sh",
            scratch.join("tmp.link").display()
        ));
        assert!(fits(&link, &c).unwrap_err().contains("not a directory"));
        let missing = run(&format!(
            "run --rm --platform linux/amd64 -v {}:/repo:ro {ARCH_BASE} bash /repo/build.sh",
            dir.display()
        ));
        assert!(fits(&missing, &c).unwrap_err().contains("no build.sh"));
    }

    #[test]
    fn a_process_without_a_jobs_context_or_with_a_shape_it_refuses_never_reaches_an_engine() {
        // No context: refused before anything.
        assert_eq!(run_with(None, &argv(&format!("run --rm --platform linux/amd64 -v /x/tmp/y:/repo {ARCH_BASE} bash /repo/check.sh"))), REFUSED);
        let t = tempfile::tempdir().unwrap();
        let scratch = t.path().canonicalize().unwrap().join("tmp");
        std::fs::create_dir_all(&scratch).unwrap();
        let file = t.path().join("helper.json");
        let mut c = ctx(&scratch);
        // An engine that records it was called: it must not be.
        let called = t.path().join("called");
        let fake = t.path().join("engine");
        std::fs::write(
            &fake,
            format!("#!/bin/sh\necho \"$@\" >> {}\n", called.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        c.engine = fake;
        std::fs::write(&file, serde_json::to_vec(&c).unwrap()).unwrap();
        let shim = |s: &str| run_with(Some(&file), &argv(s));
        assert_eq!(
            shim(&format!("create --platform linux/amd64 {ARCH_BASE} true")),
            REFUSED
        );
        assert_eq!(shim("ps -a"), REFUSED);
        assert_eq!(shim(&format!("run --rm --privileged --platform linux/amd64 -v {}/x:/repo {ARCH_BASE} bash /repo/check.sh", scratch.display())), REFUSED);
        // A shape it takes, but a directory the script did not make: refused before the engine too.
        assert_eq!(
            shim(&format!(
                "run --rm --platform linux/amd64 -v {}/x:/repo {ARCH_BASE} bash /repo/check.sh",
                scratch.display()
            )),
            REFUSED
        );
        // A context that does not read.
        std::fs::write(&file, "{").unwrap();
        assert_eq!(
            shim(&format!(
                "run --rm --platform linux/amd64 -v {}/x:/repo {ARCH_BASE} bash /repo/check.sh",
                scratch.display()
            )),
            REFUSED
        );
        assert!(!called.exists(), "no engine call for a refused run");
    }

    /// An engine that answers the shim's calls as Docker 28 does (#407), each call recorded in
    /// `calls`; the helper's own `run` lists `look` as it finds them when it starts (`ls -lnd`,
    /// into `seen`) and exits 7, which the shim must hand back.
    fn recording_engine(at: &Path, calls: &Path, seen: &Path, look: &[PathBuf]) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let fake = at.join("engine");
        let look: Vec<String> = look.iter().map(|p| format!("'{}'", p.display())).collect();
        std::fs::write(
            &fake,
            format!(
                r#"#!/bin/sh
echo "$*" >> '{calls}'
case "$1" in
  version) echo '{{"Version":"28.0.4","Components":[{{"Name":"Engine"}}]}}' ;;
  run) case "$*" in *"-helper "*) ls -lnd {look} > '{seen}'; exit 7 ;; esac ;;
esac
exit 0
"#,
                calls = calls.display(),
                seen = seen.display(),
                look = look.join(" "),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        fake
    }

    /// What a helper's directory holds as a job's scripts leave it with umask 077 (#407): a
    /// check's (`mktemp -d`, 0700, its script, a keyring in a directory of its own, each
    /// owner-only, and a link to an owner-only file outside it) and an export's (its script).
    struct Scratch {
        _t: tempfile::TempDir,
        base: PathBuf,
        check: PathBuf,
        export: PathBuf,
        outside: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            use std::fs::Permissions;
            use std::os::unix::fs::PermissionsExt as _;
            let t = tempfile::tempdir().unwrap();
            let base = t.path().canonicalize().unwrap();
            let (check, export) = (base.join("tmp/tmp.check"), base.join("tmp/tmp.export"));
            let outside = base.join("outside");
            for d in [&check.join("keyrings"), &export, &outside] {
                std::fs::create_dir_all(d).unwrap();
            }
            for f in [
                check.join("check.sh"),
                check.join("keyrings/pool.gpg"),
                export.join("export.sh"),
                outside.join("secret"),
            ] {
                std::fs::write(&f, "x\n").unwrap();
                std::fs::set_permissions(&f, Permissions::from_mode(0o600)).unwrap();
            }
            std::os::unix::fs::symlink(outside.join("secret"), check.join("secret")).unwrap();
            for d in [&check, &check.join("keyrings"), &export, &outside] {
                std::fs::set_permissions(d, Permissions::from_mode(0o700)).unwrap();
            }
            Self {
                _t: t,
                base,
                check,
                export,
                outside,
            }
        }

        /// The shim on this scratch with a context naming `root`, through [`recording_engine`].
        fn shim(&self, root: Option<TaskRoot>, args: &str) -> i32 {
            let look = [
                self.check.clone(),
                self.check.join("check.sh"),
                self.check.join("keyrings"),
                self.check.join("keyrings/pool.gpg"),
                self.export.clone(),
                self.export.join("export.sh"),
            ];
            let c = Context {
                engine: recording_engine(&self.base, &self.calls(), &self.seen(), &look),
                task_root: root,
                ..ctx(&self.base.join("tmp"))
            };
            let file = self.base.join("helper.json");
            std::fs::write(&file, serde_json::to_vec(&c).unwrap()).unwrap();
            run_with(Some(&file), &argv(args))
        }

        fn read_only(&self) -> String {
            format!(
                "run --rm --platform linux/amd64 -e KEYRING=archlinux -v {}:/repo:ro {ARCH_BASE} bash /repo/check.sh",
                self.check.display()
            )
        }

        fn writable(&self) -> String {
            format!(
                "run --rm --platform linux/amd64 -v {}:/repo {ARCH_BASE} bash /repo/export.sh",
                self.export.display()
            )
        }

        fn calls(&self) -> PathBuf {
            self.base.join("calls")
        }

        fn seen(&self) -> PathBuf {
            self.base.join("seen")
        }

        /// What the helper found of `p` when it started: its mode as `ls` writes it, and its owner.
        fn seen_of(&self, p: &Path) -> (String, String) {
            let seen = std::fs::read_to_string(self.seen()).unwrap();
            let p = p.display().to_string();
            let f = seen
                .lines()
                .map(|l| l.split_whitespace().collect::<Vec<_>>())
                .find(|f| f.last() == Some(&p.as_str()))
                .unwrap_or_else(|| panic!("{p} not in {seen}"));
            (f[0][..10].to_owned(), format!("{}:{}", f[2], f[3]))
        }
    }

    fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::MetadataExt as _;
        std::fs::symlink_metadata(p).unwrap().mode() & 0o7777
    }

    fn owner(p: &Path) -> (u32, u32) {
        use std::os::unix::fs::MetadataExt as _;
        let m = std::fs::metadata(p).unwrap();
        (m.uid(), m.gid())
    }

    /// #407: on a remapped daemon (a context naming its task root) a helper's directory is opened
    /// to that root before the helper starts, as the helper finds it then. Mounted read-only:
    /// every directory 0755, every regular file `a+r` with its other bits kept, its owner kept, a
    /// link and what it points to outside as they were, and the other directory untouched.
    /// Mounted read-write: the directory itself given to the root (this process's own uid and
    /// gid here, a change of owner it may make wherever it runs), its mode kept, what the script
    /// put in it opened for reading. The helper's exit code comes back, and nothing is given back
    /// after.
    #[test]
    fn on_a_remapped_daemon_a_helpers_directory_is_opened_to_its_root_before_it_starts() {
        let s = Scratch::new();
        let me = owner(&s.base);
        let root = TaskRoot {
            uid: me.0,
            gid: me.1,
        };
        let me_s = format!("{}:{}", me.0, me.1);
        assert_eq!(s.shim(Some(root), &s.read_only()), 7);
        for (p, m) in [
            (s.check.clone(), "drwxr-xr-x"),
            (s.check.join("check.sh"), "-rw-r--r--"),
            (s.check.join("keyrings"), "drwxr-xr-x"),
            (s.check.join("keyrings/pool.gpg"), "-rw-r--r--"),
            (s.export.clone(), "drwx------"),
            (s.export.join("export.sh"), "-rw-------"),
        ] {
            assert_eq!(
                s.seen_of(&p),
                (m.to_owned(), me_s.clone()),
                "{}",
                p.display()
            );
        }
        assert_eq!(
            (mode(&s.check), mode(&s.check.join("check.sh"))),
            (0o755, 0o644)
        );
        assert!(std::fs::symlink_metadata(s.check.join("secret"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            (mode(&s.outside), mode(&s.outside.join("secret"))),
            (0o700, 0o600),
            "what a link points to outside the directory is left as it was"
        );
        assert_eq!(s.shim(Some(root), &s.writable()), 7);
        assert_eq!(
            s.seen_of(&s.export),
            ("drwx------".to_owned(), me_s.clone()),
            "given to the root, its mode kept"
        );
        assert_eq!(
            s.seen_of(&s.export.join("export.sh")),
            ("-rw-r--r--".to_owned(), me_s)
        );
        assert_eq!(
            (
                owner(&s.export),
                mode(&s.export),
                mode(&s.export.join("export.sh"))
            ),
            (me, 0o700, 0o644)
        );
        // Both helpers started, each after its network and its egress sidecar.
        let calls = std::fs::read_to_string(s.calls()).unwrap();
        assert_eq!(calls.matches("-helper ").count(), 2, "{calls}");
    }

    /// #407: without a task root (every engine but a remapped daemon, and a context from before
    /// it) nothing changes mode or owner, whichever way the directory is mounted.
    #[test]
    fn without_a_task_root_a_helpers_directory_is_left_as_its_script_made_it() {
        let s = Scratch::new();
        assert_eq!(s.shim(None, &s.read_only()), 7);
        assert_eq!(s.shim(None, &s.writable()), 7);
        for (p, m) in [
            (s.check.clone(), 0o700),
            (s.check.join("check.sh"), 0o600),
            (s.check.join("keyrings"), 0o700),
            (s.check.join("keyrings/pool.gpg"), 0o600),
            (s.export.clone(), 0o700),
            (s.export.join("export.sh"), 0o600),
        ] {
            assert_eq!(mode(&p), m, "{}", p.display());
        }
        assert_eq!(owner(&s.export), owner(&s.base));
    }

    /// #407: a writable directory this process may not give to the root (another uid, as a user)
    /// is refused (125) once the engine said how it keeps a gateway off the host, before the
    /// helper's network, its sidecar or the helper is started, and nothing of the directory
    /// changed; as root it is given.
    #[test]
    fn a_directory_that_cannot_be_given_to_the_task_root_starts_nothing() {
        let s = Scratch::new();
        let other = TaskRoot {
            uid: 4242,
            gid: 4343,
        };
        let code = s.shim(Some(other), &s.writable());
        if rustix::process::geteuid().is_root() {
            assert_eq!(code, 7);
            assert_eq!(owner(&s.export), (4242, 4343));
            return;
        }
        assert_eq!(code, REFUSED);
        let calls = std::fs::read_to_string(s.calls()).unwrap();
        assert!(
            calls.lines().all(|l| l.starts_with("version ")),
            "only the engine's version asked: {calls}"
        );
        assert_eq!(
            (owner(&s.export), mode(&s.export.join("export.sh"))),
            (owner(&s.base), 0o600)
        );
    }

    /// #407: the context names a task root only where there is one; one that names none reads
    /// as none.
    #[test]
    fn a_contexts_task_root_is_written_only_where_there_is_one() {
        let c = ctx(Path::new("/w/t/tmp"));
        let plain = serde_json::to_value(&c).unwrap();
        assert!(plain.get("task_root").is_none(), "{plain}");
        assert_eq!(
            serde_json::from_value::<Context>(plain).unwrap().task_root,
            None
        );
        let remapped = Context {
            task_root: Some(TaskRoot {
                uid: 165_536,
                gid: 165_536,
            }),
            ..c
        };
        let v = serde_json::to_value(&remapped).unwrap();
        assert_eq!(
            v["task_root"],
            serde_json::json!({ "uid": 165_536, "gid": 165_536 })
        );
        assert_eq!(serde_json::from_value::<Context>(v).unwrap(), remapped);
    }

    #[test]
    fn the_release_pins_are_read_from_images_env() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("tests")).unwrap();
        std::fs::write(
            t.path().join("tests/images.env"),
            format!("# pinned\nARCHLINUX_BASE=\"{ARCH_BASE}\"\nARCHLINUXARM_BASE=\"{ALARM_BASE}\"\nTAGGED=\"busybox:latest\"\n"),
        )
        .unwrap();
        assert_eq!(pinned_images(t.path()), [ARCH_BASE, ALARM_BASE]);
        // The repository's own file: what a release's pool jobs may run.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let pins = pinned_images(&repo);
        assert!(
            pins.iter().any(|p| p.contains("archlinux:base@sha256:")),
            "{pins:?}"
        );
        assert!(
            pins.iter().any(|p| p.contains("archlinuxarm:base@sha256:")),
            "{pins:?}"
        );
    }
}
