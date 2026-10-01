//! `omarchy-agent`: the trust core that `release.yml` and every host share, and the run
//! loop that rolls the host bundle out (P1, #315).
//!
//! ```text
//! omarchy-agent verify --bundle <omarchy-host-vX.Y.Z.tar.gz> --sig <bundle.sigstore.json>
//! omarchy-agent verify --statement <statement.json> --sig <bundle.sigstore.json>
//! omarchy-agent lint-set <dir> [--override <compose.override.yml>] [--envelope <agent.toml>]
//!     (<dir>/compose.yml and <dir>/set.toml)
//! omarchy-agent install [options]
//!     (what install.sh runs once the binary is in place; a stub until P1, #317)
//! omarchy-agent run [--data <dir>]       the loop (systemd --user / launchd run it)
//! omarchy-agent status [--data <dir>]    state.json and capacity.json; works with the pool down
//! omarchy-agent round [--data <dir>]     a round now (SIGUSR1 to the running agent)
//! omarchy-agent logs [--data <dir>] [-n <lines>]
//! ```
//!
//! Exit status: 0 verified or clean, 1 refused, 2 usage or a file that cannot be read,
//! 3 signed and pinned but "needs a newer agent", 78 a local configuration error that
//! stops `run` (systemd's `RestartPreventExitStatus=78`); no network answer ever does.

use std::path::Path;
use std::process::ExitCode;

use omarchy_agent::lint::{self, Engine, Envelope};
use omarchy_agent::run;
use omarchy_agent::verify::{self, BundleOutcome, StatementOutcome};

const USAGE: &str = "usage:
  omarchy-agent verify --bundle <tar.gz> --sig <sigstore.json>
  omarchy-agent verify --statement <json> --sig <sigstore.json>
  omarchy-agent lint-set <dir> [--override <file>] [--envelope <agent.toml>]
  omarchy-agent install [options]
  omarchy-agent run [--data <dir>]
  omarchy-agent status [--data <dir>]
  omarchy-agent round [--data <dir>]
  omarchy-agent logs [--data <dir>] [-n <lines>]
  omarchy-agent --version";

const REFUSED: u8 = 1;
const USAGE_ERROR: u8 = 2;
const NEEDS_NEWER_AGENT: u8 = 3;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("verify") => verify_cmd(&args[1..]),
        Some("lint-set") => lint_cmd(&args[1..]),
        Some(cmd @ ("run" | "status" | "round" | "logs")) => run_cmd(cmd, &args[1..]),
        Some("install") => {
            // install.sh's last step (#311). The install with its preflight and enrollment
            // (OMARCHY_ENROLL, from the environment only) come in P1 (#317); the loop it
            // starts is `run` (#315).
            println!(
                "omarchy-agent {}: installed; the agent arrives in P1 (#317), nothing else was done",
                omarchy_agent::AGENT_VERSION
            );
            Ok(0)
        }
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

fn run_cmd(cmd: &str, args: &[String]) -> Result<u8, String> {
    let mut rest = Vec::new();
    let known: &[&'static str] = if cmd == "logs" {
        &["--data", "-n"]
    } else {
        &["--data"]
    };
    let f = flags(args, known, &mut rest)?;
    if !rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let get = |name| f.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    let data = get("--data");
    Ok(match cmd {
        "run" => run::run(data),
        "status" => run::status(data),
        "round" => run::round(data),
        _ => {
            let n = get("-n").map_or(Ok(50), |n| {
                n.parse::<usize>()
                    .map_err(|_| format!("-n {n:?} is not a number\n{USAGE}"))
            })?;
            run::logs(data, n)
        }
    })
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
