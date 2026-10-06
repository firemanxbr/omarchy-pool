//! `omarchy-agent`: the trust core that `release.yml` and every host share, and the run
//! loop that rolls the host bundle out (P1, #315).
//!
//! ```text
//! omarchy-agent verify --bundle <omarchy-host-vX.Y.Z.tar.gz> --sig <bundle.sigstore.json>
//! omarchy-agent verify --statement <statement.json> --sig <bundle.sigstore.json>
//!     (and the maintainers' co-signatures found beside the file, `<file>.<login>.sshsig`
//!     for each maintainer this agent pins, #330: said, never a refusal by hand)
//! omarchy-agent lint-set <dir> [--override <compose.override.yml>] [--envelope <agent.toml>]
//!     (<dir>/compose.yml and <dir>/set.toml)
//! omarchy-agent capacity [--envelope <agent.toml>] [--work-root <dir>] [--docker <cli>]
//!     [--probe-image <image>] [--emulate-image <image>]
//!     [--bundle <tar.gz> --sig <sigstore.json> [--write <set dir>]]
//!     (what the host has, the foreign architecture's lane included (#338: binfmt, then a
//!     smoke run of the release's build image of that architecture, or --emulate-image);
//!     with a verified release, its units, the preflight blockers, and
//!     <set dir>/run/capacity.json rewritten when it changed)
//! omarchy-agent install (--release <vX.Y.Z> | --bundle <tar.gz> --sig <sigstore.json>)
//!     [--pool <origin>] [--data-dir <dir>] [--work-root <dir>] [--secrets-dir <dir>]
//!     [--set-dir <dir>] [--socket <path>] [--task-subnets <cidr>[,<cidr>]] [--dedicated]
//!     [--direct-network | --no-direct-network] [--legacy <project>] [--agent-env-from <file>]
//!     [--max-units <n>] [--max-cpus <n>] [--max-mem-gb <n>] [--rosetta | --no-rosetta]
//!     [--wait-minutes <n>] [--yes]
//!     (#317, what install.sh runs once the binary is in place: preflight, the envelope,
//!     the enrollment below, agent.toml, the agent keys, the unit and linger, the service;
//!     on a Mac, #320, the omarchy Colima VM and the LaunchAgent)
//! omarchy-agent preflight <the same options>
//!     (one screen of everything that stops an install; changes nothing)
//! omarchy-agent uninstall [--data-dir <dir>]
//!     (the unit or the LaunchAgent, the bundle, task containers and sidecars; never the
//!     legacy project; on a Mac the omarchy VM is stopped, not deleted)
//! omarchy-agent enroll [--pool <origin>] [--data-dir <dir>] [--wait-minutes <n>]
//!     (#321: the one-time token from OMARCHY_ENROLL — never an argument — the host key,
//!     the owner's Confirm, the host worker token in sets/host/etc/dispatcher.env)
//! omarchy-agent token [--data-dir <dir>]
//!     (a new host worker token: the rotation every 30 days, #321)
//! omarchy-agent dispatcher-env [--data-dir <dir>] [--write]
//!     (#371: what sets/host/etc/dispatcher.env holds beside the worker token, as the agent
//!     renders it now — the host's own addresses, the secrets directory, the agent budget;
//!     --write writes it, the token and the owner's own lines kept, as the run loop does)
//! omarchy-agent run [--data-dir <dir>]       the loop (systemd --user / launchd run it)
//! omarchy-agent status [--data-dir <dir>]    state.json and capacity.json; works with the pool down
//! omarchy-agent round [--data-dir <dir>]     a round now (SIGUSR1 to the running agent)
//! omarchy-agent logs [--data-dir <dir>] [-n <lines>]
//! omarchy-agent self-test --release <vX.Y.Z> [--data-dir <dir>]
//!     (what a self-update asks of the new agent before it hands over: prints `ok`)
//! omarchy-agent runtime switch <compose/docker|compose/podman> [--socket <path>] [--data-dir <dir>]
//!     (#325: the owner moves the bundle to another driver this binary carries, with the
//!     same guard and revert; never the pool's to choose)
//!
//! Every command's data directory is `--data-dir`, `$OMARCHY_AGENT_DATA`,
//! `$XDG_DATA_HOME/omarchy-agent` or `~/.local/share/omarchy-agent` (install.sh's).
//! ```
//!
//! Exit status: 0 verified, clean, enrolled or installed, 1 refused (or a capacity or
//! preflight blocker, a probe that did not answer, or an install that left something for a
//! person, listed at its end), 2 usage or a file that cannot be read, 3 signed and pinned but
//! "needs a newer agent", 4 nobody confirmed the host in time (running it again continues),
//! 78 a local configuration error that stops `run` (systemd's `RestartPreventExitStatus=78`);
//! no network answer ever does.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use omarchy_agent::capacity::{self, probe, AgentToml, Capacity, Written};
use omarchy_agent::dispatcher_env::{self, Sources};
use omarchy_agent::enroll::{self, Failure, Options, Paths};
use omarchy_agent::install;
use omarchy_agent::lint::{self, Engine, Envelope};
use omarchy_agent::run;
use omarchy_agent::verify::cosignature::{self, Policy};
use omarchy_agent::verify::{self, BundleOutcome, StatementOutcome};

const USAGE: &str = "usage:
  omarchy-agent verify --bundle <tar.gz> --sig <sigstore.json>
  omarchy-agent verify --statement <json> --sig <sigstore.json>
  omarchy-agent lint-set <dir> [--override <file>] [--envelope <agent.toml>]
  omarchy-agent capacity [--envelope <agent.toml>] [--work-root <dir>] [--docker <cli>]
      [--probe-image <image>] [--emulate-image <image>]
      [--bundle <tar.gz> --sig <sigstore.json> [--write <set dir>]]
  omarchy-agent install (--release <vX.Y.Z> | --bundle <tar.gz> --sig <sigstore.json>)
      [--pool <origin>] [--data-dir <dir>] [--work-root <dir>] [--secrets-dir <dir>]
      [--set-dir <dir>] [--socket <path>] [--task-subnets <cidr>[,<cidr>]] [--dedicated]
      [--direct-network | --no-direct-network] [--legacy <project>] [--agent-env-from <file>]
      [--max-units <n>] [--max-cpus <n>] [--max-mem-gb <n>] [--rosetta | --no-rosetta]
      [--wait-minutes <n>] [--yes]
  omarchy-agent preflight <install's options>
  omarchy-agent uninstall [--data-dir <dir>]
  omarchy-agent enroll [--pool <origin>] [--data-dir <dir>] [--wait-minutes <n>]
  omarchy-agent token [--data-dir <dir>]
  omarchy-agent dispatcher-env [--data-dir <dir>] [--write]
  omarchy-agent run [--data-dir <dir>]
  omarchy-agent status [--data-dir <dir>]
  omarchy-agent round [--data-dir <dir>]
  omarchy-agent logs [--data-dir <dir>] [-n <lines>]
  omarchy-agent self-test --release <vX.Y.Z> [--data-dir <dir>]
  omarchy-agent runtime switch <compose/docker|compose/podman> [--socket <path>] [--data-dir <dir>]
  omarchy-agent --version
The enrollment token is read from OMARCHY_ENROLL, never from an argument.";

const REFUSED: u8 = 1;
const USAGE_ERROR: u8 = 2;
const NEEDS_NEWER_AGENT: u8 = 3;
const NOT_CONFIRMED: u8 = 4;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("verify") => verify_cmd(&args[1..]),
        Some("lint-set") => lint_cmd(&args[1..]),
        Some(cmd @ ("run" | "status" | "round" | "logs" | "self-test")) => run_cmd(cmd, &args[1..]),
        Some("capacity") => capacity_cmd(&args[1..]),
        Some(cmd @ ("install" | "preflight")) => install_cmd(cmd, &args[1..]),
        Some("uninstall") => uninstall_cmd(&args[1..]),
        Some("enroll") => enroll_cmd(&args[1..]),
        Some("token") => token_cmd(&args[1..]),
        Some("runtime") => runtime_cmd(&args[1..]),
        Some("dispatcher-env") => dispatcher_env_cmd(&args[1..]),
        Some("--version" | "version") => {
            println!("omarchy-agent {}", omarchy_agent::AGENT_VERSION);
            Ok(0)
        }
        Some("--help" | "-h" | "help") => {
            println!("{USAGE}");
            Ok(0)
        }
        _ => Err(USAGE.to_owned()),
    };
    match code {
        Ok(c) => ExitCode::from(c),
        Err(msg) => {
            eprintln!("{msg}");
            ExitCode::from(USAGE_ERROR)
        }
    }
}

/// `--flag value` pairs, each flag at most once; `positional` collects the rest.
fn flags<'a>(
    args: &'a [String],
    known: &[&'static str],
    positional: &mut Vec<&'a str>,
) -> Result<Vec<(&'static str, &'a str)>, String> {
    let mut out: Vec<(&'static str, &'a str)> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if let Some(flag) = known.iter().find(|k| **k == a.as_str()) {
            let value = it
                .next()
                .ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))?;
            if out.iter().any(|(f, _)| f == flag) {
                return Err(format!("{flag} given twice\n{USAGE}"));
            }
            out.push((flag, value));
        } else if a.starts_with("--") {
            return Err(format!("unknown option {a}\n{USAGE}"));
        } else {
            positional.push(a);
        }
    }
    Ok(out)
}

fn read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

/// The maintainers' co-signatures of `path` this agent pins, from the files beside it
/// (`<path>.<login>.sshsig`: `ssh-keygen -Y sign`'s `<path>.sig`, renamed for its
/// signer), checked over the file in `namespace` (#330).
fn cosignatures_beside(path: &str, namespace: &str) -> Result<cosignature::Cosigned, String> {
    let policy = Policy::pinned();
    if policy.logins().next().is_none() {
        return Ok(cosignature::Cosigned::default());
    }
    let message = read(path)?;
    let found = policy
        .logins()
        .filter_map(|login| {
            let sig = std::fs::read(cosignature::file_name(path, login)).ok()?;
            Some((login.to_owned(), sig))
        })
        .collect();
    Ok(policy.check(namespace, &message, &found))
}

fn verify_cmd(args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let f = flags(args, &["--bundle", "--statement", "--sig"], &mut rest)?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let get = |name| f.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    let sig = read(get("--sig").ok_or_else(|| USAGE.to_owned())?)?;
    match (get("--bundle"), get("--statement")) {
        (Some(path), None) => match verify::bundle(&read(path)?, &sig) {
            Ok(BundleOutcome::Current(b)) => {
                let m = b.manifest();
                let need = Policy::pinned().threshold();
                let c = cosignatures_beside(path, cosignature::BUNDLE_NAMESPACE)?;
                if let Err(why) = c.require(need, "this bundle") {
                    eprintln!("not yet what a host takes: {why}");
                }
                let line = serde_json::json!({
                    "verified": "bundle",
                    "sha256": b.sha256(),
                    "release": format!("v{}", m.outer().release()),
                    "created": m.outer().created(),
                    "agent": m.outer().agent().version().to_string(),
                    "min_agent": m.outer().min_agent().to_string(),
                    "signer": b.signer().identity(),
                    "signed_at": b.signer().signed_at(),
                    "cosignatures": {"required": need, "by": c.by(), "refused": c.refused()},
                });
                println!("{line}");
                Ok(0)
            }
            Ok(BundleOutcome::NeedsNewerAgent { outer, why, .. }) => {
                eprintln!(
                    "needs a newer agent: {why} (release v{} ships agent {})",
                    outer.release(),
                    outer.agent().version()
                );
                Ok(NEEDS_NEWER_AGENT)
            }
            Err(r) => Ok(refused(&r)),
        },
        (None, Some(path)) => match verify::statement(&read(path)?, &sig) {
            Ok(StatementOutcome::Current(s)) => {
                let st = s.statement();
                let c = cosignatures_beside(path, cosignature::ROLLBACK_NAMESPACE)?;
                let line = serde_json::json!({
                    "verified": "statement",
                    "seq": st.seq(),
                    "to": format!("v{}", st.to()),
                    "retracts_through": format!("v{}", st.retracts_through()),
                    "agent_to": st.agent_to().map(|v| v.to_string()),
                    "signer": s.signer().identity(),
                    "signed_at": s.signer().signed_at(),
                    "cosignatures": {"deeper_than_14_days_needs": Policy::pinned().deep_rollback(), "by": c.by(), "refused": c.refused()},
                });
                println!("{line}");
                Ok(0)
            }
            Ok(StatementOutcome::NeedsNewerAgent { why, .. }) => {
                eprintln!("needs a newer agent: {why}");
                Ok(NEEDS_NEWER_AGENT)
            }
            Err(r) => Ok(refused(&r)),
        },
        _ => Err(format!(
            "give exactly one of --bundle and --statement\n{USAGE}"
        )),
    }
}

fn run_cmd(cmd: &str, args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let known: &[&'static str] = match cmd {
        "logs" => &["--data-dir", "-n"],
        "self-test" => &["--data-dir", "--release"],
        _ => &["--data-dir"],
    };
    let f = flags(args, known, &mut rest)?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let get = |name| f.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    let data = get("--data-dir");
    Ok(match cmd {
        "run" => run::run(data),
        "status" => run::status(data),
        "round" => run::round(data),
        "self-test" => {
            let release = get("--release").ok_or_else(|| USAGE.to_owned())?;
            run::self_test(data, release)
        }
        _ => {
            let n = get("-n").map_or(Ok(50), |n| {
                n.parse::<usize>()
                    .map_err(|_| format!("-n {n:?} is not a number\n{USAGE}"))
            })?;
            run::logs(data, n)
        }
    })
}

/// `runtime switch <driver> [--socket <path>] [--data-dir <dir>]` (#325).
fn runtime_cmd(args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let f = flags(args, &["--data-dir", "--socket"], &mut rest)?;
    let ["switch", driver] = rest.as_slice() else {
        return Err(USAGE.to_owned());
    };
    let get = |name| f.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    Ok(run::runtime_switch(
        get("--data-dir"),
        driver,
        get("--socket"),
    ))
}

fn refused(r: &verify::Rejection) -> u8 {
    eprintln!("refused ({}): {r}", r.reason());
    REFUSED
}

fn lint_cmd(args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let f = flags(args, &["--override", "--envelope"], &mut rest)?;
    let [dir] = rest.as_slice() else {
        return Err(USAGE.to_owned());
    };
    let get = |name| f.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    let text =
        |path: &str| String::from_utf8(read(path)?).map_err(|_| format!("{path}: not UTF-8"));
    let envelope = match get("--envelope") {
        Some(p) => Envelope::from_agent_toml(&text(p)?)?,
        None => Envelope::reference(),
    };
    let template = text(&Path::new(dir).join("compose.yml").to_string_lossy())?;
    let set_toml = text(&Path::new(dir).join("set.toml").to_string_lossy())?;
    let over = get("--override").map(text).transpose()?;
    // The run loop (P1) passes the engine it detected; by hand and in CI, the strict case.
    let mut violations = lint::lint_compose(&template, over.as_deref(), &envelope, Engine::Rootful)
        .err()
        .unwrap_or_default();
    violations.extend(
        lint::lint_set_toml(&set_toml, &template)
            .err()
            .unwrap_or_default(),
    );
    if violations.is_empty() {
        println!("lint-set: {dir}: clean");
        return Ok(0);
    }
    for v in &violations {
        eprintln!("lint-set: {v}");
    }
    eprintln!("lint-set: {dir}: {} violation(s)", violations.len());
    Ok(REFUSED)
}

fn enroll_options(args: &[String]) -> Result<Options, String> {
    let mut rest = Vec::new();
    let f = flags(args, &["--pool", "--data-dir", "--wait-minutes"], &mut rest)?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let get = |name| f.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    let wait = match get("--wait-minutes") {
        Some(m) => m
            .parse::<u64>()
            .map_err(|_| format!("--wait-minutes: {m} is not a number\n{USAGE}"))?,
        None => 30,
    };
    Ok(Options {
        pool: get("--pool").map(str::to_owned),
        paths: Paths::installed(&run::config::data_dir(get("--data-dir"))?),
        // From the environment only: an argument would show in `ps` (design v2 §13.1).
        token: std::env::var("OMARCHY_ENROLL")
            .ok()
            .filter(|t| !t.is_empty()),
        wait: Duration::from_secs(wait * 60),
        poll: Duration::from_secs(5),
        sources: Sources::system(),
    })
}

fn enroll_cmd(args: &[String]) -> Result<u8, String> {
    let o = enroll_options(args)?;
    let mut out = std::io::stdout();
    match enroll::run(&o, &mut out) {
        Ok(()) => Ok(0),
        Err(Failure::Refused(why)) => {
            eprintln!("omarchy-agent: {why}");
            Ok(REFUSED)
        }
        Err(Failure::TimedOut(why)) => {
            eprintln!("omarchy-agent: {why}");
            Ok(NOT_CONFIRMED)
        }
    }
}

/// Switches (no value) out of `args`: the rest, and the switches given.
fn switches(args: &[String], known: &[&'static str]) -> (Vec<String>, Vec<&'static str>) {
    let mut rest = Vec::new();
    let mut on = Vec::new();
    for a in args {
        match known.iter().find(|k| **k == a.as_str()) {
            Some(k) => on.push(*k),
            None => rest.push(a.clone()),
        }
    }
    (rest, on)
}

/// A switch and its opposite among `on`: `Some(true)`, `Some(false)`, or `None` for neither,
/// which keeps what agent.toml says; both is a usage error.
fn either(on: &[&str], yes: &str, no: &str) -> Result<Option<bool>, String> {
    match (on.contains(&yes), on.contains(&no)) {
        (true, true) => Err(format!("{yes} or {no}, not both\n{USAGE}")),
        (true, false) => Ok(Some(true)),
        (false, true) => Ok(Some(false)),
        (false, false) => Ok(None),
    }
}

fn install_options(args: &[String]) -> Result<install::Options, String> {
    let (args, on) = switches(
        args,
        &[
            "--yes",
            "--dedicated",
            "--direct-network",
            "--no-direct-network",
            "--rosetta",
            "--no-rosetta",
        ],
    );
    let direct_network = either(&on, "--direct-network", "--no-direct-network")?;
    let rosetta = either(&on, "--rosetta", "--no-rosetta")?;
    let mut rest = Vec::new();
    let f = flags(
        &args,
        &[
            "--release",
            "--bundle",
            "--sig",
            "--pool",
            "--data-dir",
            "--wait-minutes",
            "--work-root",
            "--secrets-dir",
            "--set-dir",
            "--socket",
            "--task-subnets",
            "--legacy",
            "--agent-env-from",
            "--max-units",
            "--max-cpus",
            "--max-mem-gb",
        ],
        &mut rest,
    )?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let get = |name: &str| f.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    let num = |name: &str| -> Result<Option<u32>, String> {
        get(name)
            .map(|v| {
                v.parse::<u32>()
                    .map_err(|_| format!("{name}: {v} is not a number\n{USAGE}"))
            })
            .transpose()
    };
    let path = |name: &str| get(name).map(PathBuf::from);
    let source = match (get("--release"), get("--bundle"), get("--sig")) {
        (Some(r), None, None) => Some(install::Source::Release(
            omarchy_agent::version::Release::parse(r)
                .ok_or_else(|| format!("--release {r:?} is not vX.Y.Z\n{USAGE}"))?,
        )),
        (None, Some(b), Some(s)) => Some(install::Source::Files(b.into(), s.into())),
        _ => {
            return Err(format!(
                "give --release (install.sh passes it), or --bundle with --sig\n{USAGE}"
            ))
        }
    };
    Ok(install::Options {
        places: install::Places::from_env(get("--data-dir"))?,
        source,
        pool: get("--pool").map(str::to_owned),
        work_root: path("--work-root"),
        secrets_dir: path("--secrets-dir"),
        set_dir: path("--set-dir"),
        socket: path("--socket"),
        rosetta,
        task_subnets: get("--task-subnets").map(str::to_owned),
        dedicated: on.contains(&"--dedicated"),
        direct_network,
        legacy: get("--legacy").map(str::to_owned),
        agent_env_from: path("--agent-env-from"),
        max_units: num("--max-units")?,
        max_cpus: num("--max-cpus")?,
        max_mem_gb: num("--max-mem-gb")?,
        yes: on.contains(&"--yes"),
        // From the environment only: an argument would show in `ps` (design v2 §13.1).
        token: std::env::var("OMARCHY_ENROLL")
            .ok()
            .filter(|t| !t.is_empty()),
        wait: Duration::from_secs(u64::from(num("--wait-minutes")?.unwrap_or(30)) * 60),
        poll: Duration::from_secs(5),
        exe: None,
    })
}

/// `install` (install.sh's last step) and `preflight` (#317).
fn install_cmd(cmd: &str, args: &[String]) -> Result<u8, String> {
    let o = install_options(args)?;
    let mut sys = install::Machine::default();
    let mut out = std::io::stdout();
    if cmd == "preflight" {
        return Ok(match install::preflight(&o, &mut sys) {
            Ok(r) => {
                print!("{}", r.screen());
                if r.ok() {
                    0
                } else {
                    REFUSED
                }
            }
            Err(e) => install_failure(&e),
        });
    }
    Ok(match install::install(&o, &mut sys, &mut out) {
        Ok(done) if done.needs_person.is_empty() => 0,
        Ok(_) => REFUSED,
        Err(e) => install_failure(&e),
    })
}

fn install_failure(e: &install::Failure) -> u8 {
    eprintln!("omarchy-agent: {e}");
    match e {
        install::Failure::Refused(_) => REFUSED,
        install::Failure::NeedsNewerAgent(_) => NEEDS_NEWER_AGENT,
        install::Failure::TimedOut(_) => NOT_CONFIRMED,
    }
}

/// A Mac's engine (#320, [`probe::in_mac_vm`], as install and the run loop count it): the
/// VM's level, the omarchy VM's own `MemAvailable` (M7, read inside it with a deadline),
/// and the `x86_64` lane through Rosetta once its smoke run passed, unless the envelope's
/// `emulate` leaves it out.
fn mac_facts(
    facts: capacity::Facts,
    toml: &AgentToml,
    how: &probe::Probe<'_>,
    manifest: Option<&omarchy_agent::manifest::Manifest>,
) -> capacity::Facts {
    let Some((runtime, rosetta)) = &toml.vm else {
        return facts;
    };
    let kind = if runtime == "colima" {
        capacity::VmKind::Dedicated
    } else {
        capacity::VmKind::Shared
    };
    let meminfo = (kind == capacity::VmKind::Dedicated)
        .then(|| {
            omarchy_agent::vm::colima(
                &[
                    "ssh",
                    "--profile",
                    omarchy_agent::vm::PROFILE,
                    "--",
                    "cat",
                    "/proc/meminfo",
                ],
                &[],
                probe::ENGINE_TIMEOUT,
            )
            .map_err(|e| eprintln!("capacity: the VM's /proc/meminfo: {e}"))
            .ok()
        })
        .flatten();
    let x86 = manifest
        .and_then(|m| m.build_image("x86_64"))
        .map(ToString::to_string);
    let vm = probe::MacVm {
        kind,
        meminfo: meminfo.as_deref(),
        rosetta: *rosetta,
        emulate: toml.caps.emulate.as_deref(),
        x86_64_image: x86.as_deref(),
    };
    let (facts, said) = probe::in_mac_vm(facts, &vm, &mut |img| probe::rosetta_lane(how, img));
    match said {
        Some(probe::LaneSaid::Note(s) | probe::LaneSaid::Warning(s)) => eprintln!("capacity: {s}"),
        None => {}
    }
    facts
}

fn uninstall_cmd(args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let f = flags(args, &["--data-dir"], &mut rest)?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let places =
        install::Places::from_env(f.iter().find(|(k, _)| *k == "--data-dir").map(|(_, v)| *v))?;
    match install::uninstall(
        &places,
        &mut install::Machine::default(),
        &mut std::io::stdout(),
    ) {
        Ok(left) if left.is_empty() => Ok(0),
        Ok(left) => {
            for l in left {
                eprintln!("omarchy-agent: {l}");
            }
            Ok(REFUSED)
        }
        Err(e) => {
            eprintln!("omarchy-agent uninstall: {e}");
            Ok(REFUSED)
        }
    }
}

fn token_cmd(args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let f = flags(args, &["--data-dir"], &mut rest)?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let dir = run::config::data_dir(f.iter().find(|(k, _)| *k == "--data-dir").map(|(_, v)| *v))?;
    let o = Options {
        pool: None,
        paths: Paths::installed(&dir),
        token: None,
        wait: Duration::ZERO,
        poll: Duration::ZERO,
        sources: Sources::system(),
    };
    match enroll::rotate(&o, &mut std::io::stdout()) {
        Ok(()) => Ok(0),
        Err(e) => {
            eprintln!("omarchy-agent: {e}");
            Ok(REFUSED)
        }
    }
}

/// `dispatcher-env [--write]` (#371): the lines the agent renders beside the worker token;
/// with `--write`, `etc/dispatcher.env` rendered again.
fn dispatcher_env_cmd(args: &[String]) -> Result<u8, String> {
    let (args, on) = switches(args, &["--write"]);
    let mut rest = Vec::new();
    let f = flags(&args, &["--data-dir"], &mut rest)?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let dir = run::config::data_dir(f.iter().find(|(k, _)| *k == "--data-dir").map(|(_, v)| *v))?;
    match dispatcher_env::command(&dir, &Sources::system(), on.contains(&"--write")) {
        Ok((lines, written)) => {
            for l in lines {
                println!("{l}");
            }
            match written {
                Some(dispatcher_env::Refresh::Written) => {
                    eprintln!("omarchy-agent: wrote etc/dispatcher.env (0600), the worker token and the owner's own lines kept");
                }
                Some(dispatcher_env::Refresh::Unchanged) => {
                    eprintln!("omarchy-agent: etc/dispatcher.env already says this");
                }
                Some(dispatcher_env::Refresh::NoFile) => {
                    eprintln!("omarchy-agent: no etc/dispatcher.env yet (the owner has not confirmed the host); nothing written");
                    return Ok(REFUSED);
                }
                None => {}
            }
            Ok(0)
        }
        Err(e) => {
            eprintln!("omarchy-agent dispatcher-env: {e}");
            Ok(REFUSED)
        }
    }
}

fn capacity_cmd(args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let f = flags(
        args,
        &[
            "--envelope",
            "--work-root",
            "--docker",
            "--probe-image",
            "--emulate-image",
            "--bundle",
            "--sig",
            "--write",
        ],
        &mut rest,
    )?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let get = |name| f.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    let toml = match get("--envelope") {
        Some(p) => {
            AgentToml::parse(&String::from_utf8(read(p)?).map_err(|_| format!("{p}: not UTF-8"))?)?
        }
        None => AgentToml::default(),
    };
    let work_root = get("--work-root")
        .map(str::to_owned)
        .or_else(|| toml.work_root.clone())
        .ok_or_else(|| format!("give --work-root or an --envelope with set.work_root\n{USAGE}"))?;
    let host = toml.socket_cli.as_ref().map(|s| format!("unix://{s}"));

    // With a release: its signed constants, and its build image for the probe container.
    let manifest = match (get("--bundle"), get("--sig")) {
        (Some(b), Some(s)) => match verify::bundle(&read(b)?, &read(s)?) {
            Ok(BundleOutcome::Current(v)) => Some(v.manifest().clone()),
            Ok(BundleOutcome::NeedsNewerAgent { why, .. }) => {
                eprintln!("needs a newer agent: {why}");
                return Ok(NEEDS_NEWER_AGENT);
            }
            Err(r) => return Ok(refused(&r)),
        },
        (None, None) if get("--write").is_none() => None,
        _ => {
            return Err(format!(
                "--bundle and --sig go together, and --write needs them\n{USAGE}"
            ))
        }
    };
    let build_image = manifest
        .as_ref()
        .and_then(|m| m.build_image(std::env::consts::ARCH))
        .map(ToString::to_string);
    // The build images the emulated lane's smoke run may start (#338): detection picks the
    // engine's foreign architecture's.
    let images = capacity::emulation::images(get("--emulate-image"), manifest.as_ref());
    let how = probe::Probe {
        docker: get("--docker").unwrap_or("docker"),
        host: host.as_deref(),
        work_root: Path::new(&work_root),
        image: get("--probe-image").or(build_image.as_deref()),
        // A Mac's VM (`[vm]`) has its own binfmt table: its lane is Rosetta's (`mac_facts`).
        emulation: toml.vm.is_none().then_some(capacity::emulation::Probe {
            binfmt: Path::new(probe::BINFMT),
            images: &images,
            emulate: toml.caps.emulate.as_deref(),
        }),
    };
    let facts = match probe::detect(&how) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("capacity: {e}; nothing was changed");
            return Ok(REFUSED);
        }
    };
    let facts = mac_facts(facts, &toml, &how, manifest.as_ref());
    let Some(manifest) = manifest else {
        println!("{}", facts.report());
        return Ok(0);
    };

    let c = Capacity::new(&facts, &toml.caps, manifest.capacity());
    let at = capacity::now();
    println!(
        "{}",
        serde_json::to_string(&c.file(&at)).map_err(|e| e.to_string())?
    );
    if let Some(dir) = get("--write") {
        let w = capacity::write_if_changed(Path::new(dir), &c, &at)
            .map_err(|e| format!("{dir}/run/capacity.json: {e}"))?;
        eprintln!(
            "capacity: {dir}/run/capacity.json {}",
            match w {
                Written::Changed => "changed",
                Written::Unchanged => "unchanged",
            }
        );
    }
    let blockers = capacity::preflight(&c);
    for b in &blockers {
        eprintln!("preflight: {b}");
    }
    Ok(if blockers.is_empty() { 0 } else { REFUSED })
}
