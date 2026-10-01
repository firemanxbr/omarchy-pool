//! `omarchy-agent`: in P0, only the trust core that `release.yml` and every host share.
//!
//! ```text
//! omarchy-agent verify --bundle <omarchy-host-vX.Y.Z.tar.gz> --sig <bundle.sigstore.json>
//! omarchy-agent verify --statement <statement.json> --sig <bundle.sigstore.json>
//! omarchy-agent lint-set <dir> [--override <compose.override.yml>] [--envelope <agent.toml>]
//!     (<dir>/compose.yml and <dir>/set.toml)
//! omarchy-agent capacity [--envelope <agent.toml>] [--work-root <dir>] [--docker <cli>]
//!     [--probe-image <image>] [--bundle <tar.gz> --sig <sigstore.json> [--write <set dir>]]
//!     (what the host has; with a verified release, its units, the preflight blockers, and
//!     <set dir>/run/capacity.json rewritten when it changed)
//! omarchy-agent install [--pool <origin>] [--data-dir <dir>] [--wait-minutes <n>]
//!     (what install.sh runs once the binary is in place: in P1 so far, the enrollment
//!     below when OMARCHY_ENROLL is set or the machine enrolled; the rest is #317)
//! omarchy-agent enroll [--pool <origin>] [--data-dir <dir>] [--wait-minutes <n>]
//!     (#321: the one-time token from OMARCHY_ENROLL — never an argument — the host key,
//!     the owner's Confirm, the host worker token in sets/host/etc/dispatcher.env)
//! omarchy-agent token [--data-dir <dir>]
//!     (a new host worker token: the rotation every 30 days, #321)
//! ```
//!
//! Exit status: 0 verified, clean or enrolled, 1 refused (or a capacity blocker, or a probe
//! that did not answer), 2 usage or a file that cannot be read, 3 signed and pinned but
//! "needs a newer agent", 4 nobody confirmed the host in time (running it again continues).

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use omarchy_agent::capacity::{self, probe, AgentToml, Capacity, Written};
use omarchy_agent::enroll::{self, Failure, Options, Paths};
use omarchy_agent::lint::{self, Engine, Envelope};
use omarchy_agent::verify::{self, BundleOutcome, StatementOutcome};

const USAGE: &str = "usage:
  omarchy-agent verify --bundle <tar.gz> --sig <sigstore.json>
  omarchy-agent verify --statement <json> --sig <sigstore.json>
  omarchy-agent lint-set <dir> [--override <file>] [--envelope <agent.toml>]
  omarchy-agent capacity [--envelope <agent.toml>] [--work-root <dir>] [--docker <cli>]
      [--probe-image <image>] [--bundle <tar.gz> --sig <sigstore.json> [--write <set dir>]]
  omarchy-agent install [--pool <origin>] [--data-dir <dir>] [--wait-minutes <n>]
  omarchy-agent enroll [--pool <origin>] [--data-dir <dir>] [--wait-minutes <n>]
  omarchy-agent token [--data-dir <dir>]
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
        Some("capacity") => capacity_cmd(&args[1..]),
        Some("install") => install_cmd(&args[1..]),
        Some("enroll") => enroll_cmd(&args[1..]),
        Some("token") => token_cmd(&args[1..]),
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
                let line = serde_json::json!({
                    "verified": "bundle",
                    "sha256": b.sha256(),
                    "release": format!("v{}", m.outer().release()),
                    "created": m.outer().created(),
                    "agent": m.outer().agent().version().to_string(),
                    "min_agent": m.outer().min_agent().to_string(),
                    "signer": b.signer().identity(),
                    "signed_at": b.signer().signed_at(),
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
                let line = serde_json::json!({
                    "verified": "statement",
                    "seq": st.seq(),
                    "to": format!("v{}", st.to()),
                    "retracts_through": format!("v{}", st.retracts_through()),
                    "agent_to": st.agent_to().map(|v| v.to_string()),
                    "signer": s.signer().identity(),
                    "signed_at": s.signer().signed_at(),
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

/// The agent's data directory: `--data-dir`, or install.sh's
/// `${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-agent`.
fn data_dir(given: Option<&str>) -> Result<PathBuf, String> {
    if let Some(d) = given {
        return Ok(PathBuf::from(d));
    }
    let base = match std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        Some(x) => PathBuf::from(x),
        None => {
            PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join(".local/share")
        }
    };
    Ok(base.join("omarchy-agent"))
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
        paths: Paths::under(&data_dir(get("--data-dir"))?),
        // From the environment only: an argument would show in `ps` (design v2 §13.1).
        token: std::env::var("OMARCHY_ENROLL")
            .ok()
            .filter(|t| !t.is_empty()),
        wait: Duration::from_secs(wait * 60),
        poll: Duration::from_secs(5),
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

/// install.sh's last step (#311). In P1 so far it enrolls the machine (#321) when it has a
/// token or an identity; the install with its preflight, the runtime, the envelope and the
/// first rollout is #317's.
fn install_cmd(args: &[String]) -> Result<u8, String> {
    let o = enroll_options(args)?;
    let enrolled = o
        .paths
        .state
        .join(omarchy_agent::host::IDENTITY_FILE)
        .exists();
    if o.token.is_none() && !enrolled {
        println!(
            "omarchy-agent {}: installed; the install itself arrives in P1 (#317), nothing else was done",
            omarchy_agent::AGENT_VERSION
        );
        return Ok(0);
    }
    enroll_cmd(args)
}

fn token_cmd(args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let f = flags(args, &["--data-dir"], &mut rest)?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let dir = data_dir(f.iter().find(|(k, _)| *k == "--data-dir").map(|(_, v)| *v))?;
    let o = Options {
        pool: None,
        paths: Paths::under(&dir),
        token: None,
        wait: Duration::ZERO,
        poll: Duration::ZERO,
    };
    match enroll::rotate(&o, &mut std::io::stdout()) {
        Ok(()) => Ok(0),
        Err(e) => {
            eprintln!("omarchy-agent: {e}");
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
    let how = probe::Probe {
        docker: get("--docker").unwrap_or("docker"),
        host: host.as_deref(),
        work_root: Path::new(&work_root),
        image: get("--probe-image").or(build_image.as_deref()),
    };
    let facts = match probe::detect(&how) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("capacity: {e}; nothing was changed");
            return Ok(REFUSED);
        }
    };
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
