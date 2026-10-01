//! `set.toml` (design v2 §4.2), schema 3: how the agent rolls the set out, and what the
//! host needs that the agent checks but never does. Strict: an unknown key is refused, and
//! a newer schema is a newer agent's to read. Checked against the template beside it, so
//! the ready checks, the order and the env files name the services compose runs.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use super::yaml::{self, Node};
use super::{is_relative_inside, normalize, violation, Violation};

/// The `set.toml` schema this agent reads.
pub const SET_SCHEMA: i64 = 3;

/// What the agent checks per lane before it turns it on, and never does itself
/// (design v2 §7.5: binfmt for an emulated lane; `factory/host/prep-root.sh` installs it).
const HOST_NEEDS: &[(&str, &[&str])] = &[("emulated", &["binfmt"])];

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetToml {
    pub schema: i64,
    /// The compose project name, unless the envelope sets another.
    pub project_default: String,
    /// Services rolled out one by one, in this order, before the rest.
    pub order: Vec<String>,
    /// How long a new set must stay up before the rollout keeps it.
    pub guard_s: u32,
    #[serde(default)]
    pub ready: BTreeMap<String, Ready>,
    #[serde(default)]
    pub needs: Needs,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ready {
    /// `127.0.0.1:<port>/<path>`, asked from inside the service's network namespace.
    pub http: String,
    pub wait_s: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Needs {
    /// Per service, the env files the agent writes before compose loads the set.
    #[serde(default)]
    pub env_files: BTreeMap<String, Vec<String>>,
    /// Per lane kind, the host checks a person does once (`prep-root.sh`).
    #[serde(default)]
    pub host: BTreeMap<String, Vec<String>>,
}

/// Parses `set.toml` strictly, schema 3 only.
pub fn parse_set_toml(text: &str) -> Result<SetToml, String> {
    let table: toml::Table = toml::from_str(text).map_err(|e| format!("set.toml: {e}"))?;
    let schema = table.get("schema");
    if schema.and_then(toml::Value::as_integer) != Some(SET_SCHEMA) {
        let found = schema.map_or_else(|| "none".to_owned(), ToString::to_string);
        return Err(format!(
            "set.toml: schema must be {SET_SCHEMA}, found {found}"
        ));
    }
    toml::from_str(text).map_err(|e| format!("set.toml: {e}"))
}

/// Lints `set.toml` on its own and against the template it sits beside. A template that
/// does not parse is `lint_compose`'s violation; here it only skips the cross-checks.
pub fn lint_set_toml(set_toml: &str, template: &str) -> Result<(), Vec<Violation>> {
    let set = parse_set_toml(set_toml).map_err(|e| vec![violation("set_toml", e)])?;
    let mut out = Vec::new();
    let mut bad = |m: String| out.push(violation("set_toml", m));

    if !is_project_name(&set.project_default) {
        bad(format!(
            "project_default {:?} is not a compose project name",
            set.project_default
        ));
    }
    if set.guard_s == 0 {
        bad("guard_s must be above 0".into());
    }
    for (service, ready) in &set.ready {
        if !is_loopback_http(&ready.http) {
            bad(format!(
                "ready.{service}.http {:?} is not 127.0.0.1:<port>/<path>",
                ready.http
            ));
        }
        if ready.wait_s == 0 {
            bad(format!("ready.{service}.wait_s must be above 0"));
        }
    }
    for (service, files) in &set.needs.env_files {
        for f in files {
            if !is_relative_inside(Path::new(f)) || f.is_empty() {
                bad(format!(
                    "needs.env_files.{service}: {f:?} leaves the set directory"
                ));
            }
        }
    }
    for (lane, checks) in &set.needs.host {
        let known = HOST_NEEDS.iter().find(|(l, _)| l == lane);
        match known {
            None => bad(format!(
                "needs.host.{lane}: not a lane kind this agent checks"
            )),
            Some((_, allowed)) => {
                for c in checks.iter().filter(|c| !allowed.contains(&c.as_str())) {
                    bad(format!(
                        "needs.host.{lane}: {c:?} is not a check this agent knows"
                    ));
                }
            }
        }
    }

    if let Some(services) = template_services(template) {
        let names: Vec<&str> = services.iter().map(|(n, _)| n.as_str()).collect();
        let unknown = |what: &str, s: &str| {
            format!("{what} names {s:?}, which is not a service of compose.yml ({names:?})")
        };
        let mut seen = Vec::new();
        for s in &set.order {
            if !names.contains(&s.as_str()) {
                bad(unknown("order", s));
            } else if seen.contains(&s) {
                bad(format!("order names {s:?} twice"));
            }
            seen.push(s);
        }
        for s in set.ready.keys().filter(|s| !names.contains(&s.as_str())) {
            bad(unknown("ready", s));
        }
        for s in set
            .needs
            .env_files
            .keys()
            .filter(|s| !names.contains(&s.as_str()))
        {
            bad(unknown("needs.env_files", s));
        }
        for (name, service) in &services {
            // The rollout guard waits on it: a service with no ready check would pass at once.
            if !set.ready.contains_key(name) {
                bad(format!("{name}: no [ready.\"{name}\"] check"));
            }
            // Compose loads no project with an env file missing (#295): the agent writes
            // exactly the ones compose names.
            let mut wants = env_files(service);
            wants.sort();
            let mut listed: Vec<String> = set
                .needs
                .env_files
                .get(name)
                .map(|v| v.iter().map(|f| strip_dot(f).to_owned()).collect())
                .unwrap_or_default();
            listed.sort();
            if wants != listed {
                bad(format!(
                    "needs.env_files.{name} must list the env files compose.yml names ({wants:?}), found {listed:?}"
                ));
            }
        }
    }

    if out.is_empty() {
        Ok(())
    } else {
        Err(out)
    }
}

fn template_services(template: &str) -> Option<Vec<(String, Node)>> {
    let Node::Map(top) = normalize(yaml::parse(template).ok()?) else {
        return None;
    };
    let (_, services) = top.into_iter().find(|(k, _)| k == "services")?;
    match services {
        Node::Map(entries) => Some(entries),
        _ => None,
    }
}

/// The env files a (normalized) service names, as paths relative to the set directory.
fn env_files(service: &Node) -> Vec<String> {
    let Some(Node::Seq(items)) = service.get("env_file") else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|i| match i {
            Node::Scalar(s) => Some(s.as_str()),
            Node::Map(_) => i.get("path").and_then(Node::as_str),
            _ => None,
        })
        .map(|p| strip_dot(p).to_owned())
        .collect()
}

fn strip_dot(p: &str) -> &str {
    p.strip_prefix("./").unwrap_or(p)
}

/// Compose's rule: lowercase letters, digits, `-` and `_`, starting with a letter or digit.
fn is_project_name(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn is_loopback_http(s: &str) -> bool {
    let Some((port, path)) = s.strip_prefix("127.0.0.1:").and_then(|r| r.split_once('/')) else {
        return false;
    };
    port.parse::<u16>().is_ok_and(|p| p != 0)
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~/".contains(c))
}
