//! The host set as a Quadlet unit (design v2 §15, v1 §10.2; #330): for a rootless podman
//! host with no compose, each service of the set — the dispatcher — renders to one
//! `<name>.container` file under the user's `~/.config/containers/systemd/`, which podman's
//! generator turns into a systemd user service. The same bundle serves both drivers: what
//! the compose driver hands compose (the template, the agent's label overlay and the owner's
//! override, agent.toml's variables) is what this reads, with compose's own merge and
//! interpolation, so one set means one container whichever driver runs it.
//!
//! Every field of the template subset (design v2 §4.3) has its Quadlet key or `podman run`
//! flag; what the subset allows but a single rootless service cannot mean the same way
//! there — a service network, `depends_on`, `profiles`, a string command that would need a
//! shell's quoting — is refused by name, and `lint-set` says so before any host meets it
//! ([`crate::lint::lint_quadlet`]). podman's `AutoUpdate=` is never written: the agent
//! alone moves a host to another release, behind its guard.
//!
//! The unit holds agent.toml's interpolated values — paths, the task subnets — and names
//! the env files by path: the worker token in `etc/dispatcher.env` is never copied into it,
//! and the lint refuses an interpolated agent key or GitHub token before it is rendered.
//! Its hash (of everything but its comments and the hash label itself) is the container's
//! `org.omarchy-pool.agent.config-hash` label: the planner compares it as it compares
//! compose's config hash.

use std::fmt::Write as _;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::lint::yaml::{self, Node};

/// The label the unit's hash rides on, read back from the running container.
pub const HASH_LABEL: &str = "org.omarchy-pool.agent.config-hash";

/// One file compose would load, by name (for messages) and text.
#[derive(Debug, Clone, Copy)]
pub struct Source<'a> {
    pub name: &'a str,
    pub text: &'a str,
}

/// One service of the set, rendered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub service: String,
    /// The unit's name without `.container`: also the container's name, and its service is
    /// `<name>.service`.
    pub name: String,
    pub image: String,
    /// SHA-256 of the unit, hex, without its comments and its own label.
    pub hash: String,
    /// The `.container` file.
    pub text: String,
}

/// The unit (and container) name of `service` in compose project `project`: `omarchy-` in
/// front unless the project already begins with it (v1 §10.2: every file the agent writes
/// there is `omarchy-…`, never one of the owner's own units).
pub fn unit_name(project: &str, service: &str) -> String {
    if project.starts_with("omarchy-") {
        format!("{project}-{service}")
    } else {
        format!("omarchy-{project}-{service}")
    }
}

/// The oldest podman whose Quadlet reads every key [`render`] writes: `Pull=` and
/// `PodmanArgs=` came in podman 4.6 (`Tmpfs=` and `UserNS=` in 4.5). An older generator
/// rejects the whole file and makes no service of it: every round would fail at its create,
/// and the revert's last-good unit with it.
pub const PODMAN_MIN: (u32, u32) = (4, 6);

/// Why podman `version` (its `Podman Engine` component) cannot run what [`render`] writes,
/// or `None` when it can: install's preflight and the owner's switch refuse the driver
/// there, before anything is written.
pub fn podman_refused(version: &str) -> Option<String> {
    let mut parts = version.split(|c: char| !c.is_ascii_digit());
    let mut number = || parts.next().and_then(|p| p.parse::<u32>().ok());
    let (major, minor) = (number(), number());
    let (a, b) = PODMAN_MIN;
    match major.zip(minor) {
        Some(v) if v >= PODMAN_MIN => None,
        Some(_) => Some(format!(
            "podman {version} is older than {a}.{b}, whose Quadlet reads every key the agent writes (Pull=, PodmanArgs=): its generator would make no service of the dispatcher's unit"
        )),
        None => Some(format!(
            "podman's version {version:?} does not read, so whether its Quadlet reads the agent's units ({a}.{b} or later) is unknown"
        )),
    }
}

/// Renders every service of the set: `sources` in compose's order (the template, the
/// overlay, the override), relative paths resolved in `dir`, `${...}` from `env` only.
pub fn render(
    project: &str,
    dir: &Path,
    sources: &[Source<'_>],
    env: &[(String, String)],
) -> Result<Vec<Rendered>, String> {
    let mut doc: Option<Node> = None;
    for s in sources {
        let node = yaml::parse(s.text).map_err(|e| format!("{}: {e}", s.name))?;
        if !matches!(node, Node::Map(_)) {
            return Err(format!("{}: not a mapping", s.name));
        }
        let node = crate::lint::normalize(node);
        doc = Some(match doc {
            None => node,
            Some(base) => merge_top(base, node),
        });
    }
    let doc = doc.ok_or("no compose file")?;
    let named = named_volumes(&doc)?;
    let Some(Node::Map(services)) = doc.get("services") else {
        return Err("no services mapping".into());
    };
    let mut out = Vec::new();
    for (service, node) in services {
        let at = |e: String| format!("{service}: {e}");
        let s = interpolate_node(node, env).map_err(at)?;
        out.push(render_service(project, dir, service, &s, &named).map_err(at)?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------
// Merging an override the way compose does for the subset (compose-spec's merge rules):
// mappings by key, the service's volumes by their target, env files and security options
// appended once each, everything else replaced by the later file.

fn merge_top(base: Node, over: Node) -> Node {
    merge_map(base, over, |key, b, o| match key {
        "services" => merge_map(b, o, |_, b, o| merge_service(b, o)),
        // Named volumes, networks, `x-` extensions: by key, the later file's wins.
        _ => merge_map(b, o, |_, _, o| o),
    })
}

/// Two mappings by key, `f` merging a key both have; anything else, the later one.
fn merge_map(base: Node, over: Node, f: fn(&str, Node, Node) -> Node) -> Node {
    match (base, over) {
        (Node::Map(mut b), Node::Map(o)) => {
            for (k, v) in o {
                match b.iter().position(|(e, _)| *e == k) {
                    Some(i) => {
                        let old = std::mem::replace(&mut b[i].1, Node::Null);
                        b[i].1 = f(&k, old, v);
                    }
                    None => b.push((k, v)),
                }
            }
            Node::Map(b)
        }
        (_, over) => over,
    }
}

fn merge_service(base: Node, over: Node) -> Node {
    merge_map(base, over, |field, b, o| match field {
        "environment" | "labels" => merge_map(b, o, |_, _, o| o),
        "volumes" => merge_volumes(b, o),
        "env_file" | "security_opt" => append_once(b, o),
        // `command`, `entrypoint` and every single value: replaced.
        _ => o,
    })
}

fn append_once(base: Node, over: Node) -> Node {
    match (base, over) {
        (Node::Seq(mut b), Node::Seq(o)) => {
            for item in o {
                if !b.contains(&item) {
                    b.push(item);
                }
            }
            Node::Seq(b)
        }
        (_, over) => over,
    }
}

/// A service's volumes: one the override mounts at a target already mounted replaces it.
fn merge_volumes(base: Node, over: Node) -> Node {
    fn target(v: &Node) -> Option<String> {
        match v {
            Node::Scalar(s) => {
                let parts: Vec<&str> = s.split(':').collect();
                match parts.as_slice() {
                    [t] | [_, t] | [_, t, _] => Some((*t).to_owned()),
                    _ => None,
                }
            }
            Node::Map(_) => v.get("target").and_then(Node::as_str).map(str::to_owned),
            _ => None,
        }
    }
    match (base, over) {
        (Node::Seq(mut b), Node::Seq(o)) => {
            for item in o {
                let t = target(&item);
                match t
                    .as_ref()
                    .and_then(|t| b.iter().position(|e| target(e).as_ref() == Some(t)))
                {
                    Some(i) => b[i] = item,
                    None => b.push(item),
                }
            }
            Node::Seq(b)
        }
        (_, over) => over,
    }
}

// ---------------------------------------------------------------------------------------
// Interpolation, as compose does it: `$$` is a `$`, `$NAME` and `${NAME}` its value, with
// `:-`/`-` defaults, `:?`/`?` errors and `:+`/`+` alternatives, nested inside them. Values
// only (never keys), from agent.toml's variables alone. Stricter than compose in one way:
// a variable that is not set and has no default is an error, never a blank string.

fn interpolate_node(node: &Node, env: &[(String, String)]) -> Result<Node, String> {
    Ok(match node {
        Node::Null => Node::Null,
        Node::Scalar(s) => Node::Scalar(interpolate(s, env)?),
        Node::Seq(items) => Node::Seq(
            items
                .iter()
                .map(|i| interpolate_node(i, env))
                .collect::<Result<_, _>>()?,
        ),
        Node::Map(entries) => Node::Map(
            entries
                .iter()
                .map(|(k, v)| Ok((k.clone(), interpolate_node(v, env)?)))
                .collect::<Result<_, String>>()?,
        ),
    })
}

fn lookup<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .rev()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// How deep `${...}` may nest in a default or an alternative. A set's own nest one or two
/// deep; past this an input is refused rather than recursed into until the stack runs out.
const MAX_NESTING: usize = 16;

/// `s` interpolated as compose interpolates it, from `env` alone.
pub(crate) fn interpolate(s: &str, env: &[(String, String)]) -> Result<String, String> {
    interpolate_at(s, env, 0)
}

/// [`interpolate`] inside `depth` enclosing `${...}`.
fn interpolate_at(s: &str, env: &[(String, String)], depth: usize) -> Result<String, String> {
    if depth > MAX_NESTING {
        return Err(format!(
            "${{...}} nested deeper than {MAX_NESTING}: not a form a set uses"
        ));
    }
    let mut out = String::new();
    let b = s.as_bytes();
    let mut i = 0;
    let name_start = |c: u8| c.is_ascii_alphabetic() || c == b'_';
    let name_char = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    while i < b.len() {
        let Some(off) = s[i..].find('$') else {
            out.push_str(&s[i..]);
            break;
        };
        out.push_str(&s[i..i + off]);
        i += off;
        match b.get(i + 1) {
            Some(b'$') => {
                out.push('$');
                i += 2;
            }
            Some(&c) if name_start(c) => {
                let start = i + 1;
                let mut end = start;
                while end < b.len() && name_char(b[end]) {
                    end += 1;
                }
                let name = &s[start..end];
                out.push_str(lookup(env, name).ok_or_else(|| unset(name))?);
                i = end;
            }
            Some(b'{') => {
                let close = matching_brace(s, i + 1)
                    .ok_or_else(|| format!("{s:?}: a ${{ without its }}"))?;
                out.push_str(&braced(&s[i + 2..close], env, depth)?);
                i = close + 1;
            }
            _ => return Err(format!("{s:?}: a $ that is neither $$ nor a variable")),
        }
    }
    Ok(out)
}

fn unset(name: &str) -> String {
    format!("${{{name}}} is not set (agent.toml sets the set's variables)")
}

/// The index of the `}` closing the `{` at `open`, nested braces counted.
fn matching_brace(s: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, c) in s.bytes().enumerate().skip(open) {
        match c {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// What is inside `${...}`, itself inside `depth` others.
fn braced(inner: &str, env: &[(String, String)], depth: usize) -> Result<String, String> {
    let end = inner
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(inner.len());
    let (name, rest) = inner.split_at(end);
    if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) {
        return Err(format!("${{{inner}}}: not a variable name"));
    }
    let value = lookup(env, name);
    let (op, arg) = if let Some(a) = rest.strip_prefix(":-") {
        (":-", a)
    } else if let Some(a) = rest.strip_prefix(":?") {
        (":?", a)
    } else if let Some(a) = rest.strip_prefix(":+") {
        (":+", a)
    } else if rest.is_empty() {
        ("", "")
    } else {
        rest.split_at(rest.chars().next().map_or(0, char::len_utf8))
    };
    // `:` asks for a value that is set and not empty; without it, set is enough.
    let given = if op.starts_with(':') {
        value.is_some_and(|v| !v.is_empty())
    } else {
        value.is_some()
    };
    let own = || Ok(value.unwrap_or_default().to_owned());
    match (op, given) {
        ("", _) => value.map(str::to_owned).ok_or_else(|| unset(name)),
        (":-" | "-" | ":?" | "?", true) | (":+" | "+", false) => {
            if op.ends_with('+') {
                Ok(String::new())
            } else {
                own()
            }
        }
        (":-" | "-", false) | (":+" | "+", true) => interpolate_at(arg, env, depth + 1),
        (":?" | "?", false) => Err(format!(
            "${{{name}}}: {}",
            interpolate_at(arg, env, depth + 1)?
        )),
        _ => Err(format!("${{{inner}}}: not a form compose reads")),
    }
}

// ---------------------------------------------------------------------------------------
// The service, field by field.

/// The service fields the subset allows (`crate::lint`'s, design v2 §4.3) and how each is
/// rendered; anything else is refused.
const FIELDS: &[&str] = &[
    "image",
    "platform",
    "environment",
    "env_file",
    "volumes",
    "restart",
    "stop_grace_period",
    "stop_signal",
    "security_opt",
    "labels",
    "command",
    "entrypoint",
    "user",
    "userns_mode",
];

/// Fields the subset allows that one rootless Quadlet service cannot mean as compose does.
const NOT_RENDERED: &[(&str, &str)] = &[
    (
        "networks",
        "the Quadlet driver runs the dispatcher on podman's own network; a set network is compose's",
    ),
    (
        "depends_on",
        "the set has one service: it depends on none",
    ),
    (
        "profiles",
        "compose starts no service with a profile unless asked; the agent never asks",
    ),
];

/// Compose's default `stop_grace_period`.
const DEFAULT_GRACE_S: u64 = 10;
/// What systemd waits beyond the grace before it kills what is left of the unit.
const STOP_MARGIN_S: u64 = 30;

/// The unit's `[Container]` and `[Service]` lines, and whether it starts with the user's
/// manager (`[Install]`).
struct Unit {
    container: Vec<String>,
    service: Vec<String>,
    install: bool,
}

impl Unit {
    fn raw(&mut self, key: &str, value: &str) -> Result<(), String> {
        self.container.push(format!("{key}={}", raw(key, value)?));
        Ok(())
    }

    /// One line per value, each one word.
    fn each(&mut self, key: &str, values: &[String]) {
        for v in values {
            self.words(key, std::slice::from_ref(v));
        }
    }

    fn words(&mut self, key: &str, words: &[String]) {
        if words.is_empty() {
            return;
        }
        let w: Vec<String> = words.iter().map(|w| word(w)).collect();
        self.container.push(format!("{key}={}", w.join(" ")));
    }
}

#[allow(clippy::too_many_lines)] // one field after another, in the unit's own order
fn render_service(
    project: &str,
    dir: &Path,
    service: &str,
    node: &Node,
    named: &[String],
) -> Result<Rendered, String> {
    let Node::Map(fields) = node else {
        return Err("not a mapping".into());
    };
    for (f, _) in fields {
        if let Some((_, why)) = NOT_RENDERED.iter().find(|(n, _)| n == f) {
            return Err(format!("{f} is not rendered for Quadlet ({why})"));
        }
        if !FIELDS.contains(&f.as_str()) && !f.starts_with("x-") {
            return Err(format!("{f} is not in the template subset"));
        }
    }
    let name = unit_name(project, service);
    let image = node
        .get("image")
        .and_then(Node::as_str)
        .ok_or("no image")?
        .to_owned();
    let mut u = Unit {
        container: Vec::new(),
        service: Vec::new(),
        install: false,
    };
    u.raw("ContainerName", &name)?;
    u.raw("Image", &image)?;
    // The agent pulled it before it created anything (as `compose up --pull never`).
    u.raw("Pull", "never")?;
    let labels = sorted_map(node.get("labels"), "labels")?;
    u.each(
        "Label",
        &labels
            .iter()
            .map(|(k, v)| format!("{k}={}", v.as_deref().unwrap_or("")))
            .collect::<Vec<_>>(),
    );
    let env: Vec<String> = sorted_map(node.get("environment"), "environment")?
        .into_iter()
        // `KEY` with no value: compose leaves it unset, having nothing to take it from.
        .filter_map(|(k, v)| v.map(|v| format!("{k}={v}")))
        .collect();
    u.each("Environment", &env);
    for f in env_files(dir, node.get("env_file"))? {
        u.words("EnvironmentFile", &[f.display().to_string()]);
    }
    for v in volumes(project, dir, node.get("volumes"), named)? {
        match v {
            Mount::Volume(spec) => u.raw("Volume", &spec)?,
            Mount::Tmpfs(target) => u.raw("Tmpfs", &target)?,
        }
    }
    if let Some(opts) = node.get("security_opt") {
        let Node::Seq(items) = opts else {
            return Err("security_opt is not a list".into());
        };
        for i in items {
            match i.as_str() {
                Some("label=disable" | "label:disable") => {}
                other => return Err(format!("security_opt {other:?}: only label=disable")),
            }
        }
        if !items.is_empty() {
            u.raw("SecurityLabelDisable", "true")?;
        }
    }
    if let Some(user) = scalar(node, "user")? {
        check_token("user", &user, |c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ':')
        })?;
        u.raw("User", &user)?;
    }
    if let Some(ns) = scalar(node, "userns_mode")? {
        check_token("userns_mode", &ns, |c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ':' | '=' | ',')
        })?;
        u.raw("UserNS", &ns)?;
    }
    let grace = match scalar(node, "stop_grace_period")? {
        Some(d) => seconds(&d)?,
        None => DEFAULT_GRACE_S,
    };
    let mut args = vec![format!("--stop-timeout={grace}")];
    if let Some(sig) = scalar(node, "stop_signal")? {
        check_token("stop_signal", &sig, |c| {
            c.is_ascii_alphanumeric() || c == '+'
        })?;
        args.push(format!("--stop-signal={sig}"));
    }
    if let Some(p) = scalar(node, "platform")? {
        check_token("platform", &p, |c| {
            c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-')
        })?;
        args.push(format!("--platform={p}"));
    }
    let command = argv(node.get("command"), "command")?;
    let mut exec = Vec::new();
    match argv(node.get("entrypoint"), "entrypoint")? {
        // As compose: an entrypoint given (even an empty one) replaces the image's, and its
        // command with it. `--entrypoint` takes the first word, the rest lead the command.
        Some(e) => {
            let (first, rest) = e
                .split_first()
                .map_or(("", &[][..]), |(f, r)| (f.as_str(), r));
            if first.starts_with('[') {
                return Err(format!(
                    "entrypoint {first:?}: podman would read it as JSON"
                ));
            }
            args.push(format!("--entrypoint={first}"));
            exec.extend(rest.iter().cloned());
            exec.extend(command.unwrap_or_default());
        }
        None => exec.extend(command.unwrap_or_default()),
    }
    u.words("PodmanArgs", &args);
    u.words("Exec", &exec);
    match scalar(node, "restart")?.as_deref() {
        None | Some("no") => u.service.push("Restart=no".into()),
        Some("always" | "unless-stopped") => {
            u.service.push("Restart=always".into());
            u.install = true;
        }
        Some("on-failure") => {
            u.service.push("Restart=on-failure".into());
            u.install = true;
        }
        Some(other) => {
            return Err(format!(
                "restart {other:?}: no, always, unless-stopped or on-failure"
            ))
        }
    }
    // Docker restarts a container that keeps failing for as long as it takes; systemd
    // would give up after five starts in ten seconds. The guard, not the start limit,
    // decides whether a dispatcher that restarts is a bad release.
    u.service.push("RestartSec=1".into());
    u.service
        .push(format!("TimeoutStopSec={}", grace + STOP_MARGIN_S));
    // The hash of the unit as it would be without its own label: what the container's
    // label says once it runs, and what the planner compares.
    let unlabelled = body(project, service, &u, None);
    let hash = hex::encode(Sha256::digest(
        unlabelled
            .lines()
            .filter(|l| !l.starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    ));
    let text = body(project, service, &u, Some(&hash));
    Ok(Rendered {
        service: service.to_owned(),
        name,
        image,
        hash,
        text,
    })
}

fn body(project: &str, service: &str, u: &Unit, hash: Option<&str>) -> String {
    let mut t = String::new();
    let _ = writeln!(
        t,
        "# Written by omarchy-agent (design v2 §15): the host set's {service} of project\n\
         # {project}, rendered for Quadlet from the set as compose would load it. Edit the\n\
         # set's compose.override.yml, never this file: the agent writes it again."
    );
    let _ = writeln!(
        t,
        "[Unit]\nDescription={}\n# The dispatcher talks to podman's API socket.\nWants=podman.socket\nAfter=podman.socket\nStartLimitIntervalSec=0\n",
        escape_specifiers(&format!("omarchy-pool host set: {service} ({project})"))
    );
    t.push_str("[Container]\n");
    for l in &u.container {
        t.push_str(l);
        t.push('\n');
    }
    if let Some(h) = hash {
        let _ = writeln!(t, "Label={}", word(&format!("{HASH_LABEL}={h}")));
    }
    t.push_str("\n[Service]\n");
    for l in &u.service {
        t.push_str(l);
        t.push('\n');
    }
    if u.install {
        t.push_str("\n[Install]\nWantedBy=default.target\n");
    }
    t
}

/// `%` is a systemd specifier and `$` a variable in the `ExecStart` the generator writes:
/// each doubled stands for itself.
fn escape_specifiers(s: &str) -> String {
    s.replace('%', "%%").replace('$', "$$")
}

/// A value Quadlet takes whole (`Image=`, `Volume=`, ...): nothing it could read as
/// something else.
fn raw(key: &str, value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.trim() != value
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '\'' | '\\'))
    {
        return Err(format!(
            "{key} {value:?}: not a value a unit holds as written"
        ));
    }
    Ok(escape_specifiers(value))
}

/// One word of a value Quadlet splits as systemd does (`Environment=`, `Label=`, `Exec=`,
/// `PodmanArgs=`, `EnvironmentFile=`): double-quoted, with C escapes, `$$` and `%%`.
fn word(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '$' => out.push_str("$$"),
            '%' => out.push_str("%%"),
            c if c.is_control() => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    let _ = write!(out, "\\x{b:02x}");
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn check_token(what: &str, v: &str, ok: impl Fn(char) -> bool) -> Result<(), String> {
    if v.is_empty() || !v.chars().all(ok) {
        return Err(format!("{what} {v:?}: not a value this driver passes on"));
    }
    Ok(())
}

fn scalar(node: &Node, field: &str) -> Result<Option<String>, String> {
    match node.get(field) {
        None | Some(Node::Null) => Ok(None),
        Some(Node::Scalar(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{field} is not a single value")),
    }
}

/// A mapping (normalized from either form) as sorted `(key, value)` pairs.
fn sorted_map(node: Option<&Node>, what: &str) -> Result<Vec<(String, Option<String>)>, String> {
    let entries = match node {
        None | Some(Node::Null) => return Ok(Vec::new()),
        Some(Node::Map(e)) => e,
        Some(_) => return Err(format!("{what} is neither a mapping nor a list")),
    };
    let mut out = Vec::new();
    for (k, v) in entries {
        if k.is_empty() || k.chars().any(|c| c.is_control() || c == '=') {
            return Err(format!("{what}: {k:?} is not a key"));
        }
        out.push((
            k.clone(),
            match v {
                Node::Null => None,
                Node::Scalar(s) => Some(s.clone()),
                _ => return Err(format!("{what}.{k} is not a single value")),
            },
        ));
    }
    out.sort();
    Ok(out)
}

/// `command` or `entrypoint`: a list as written; a string split at blanks as compose
/// would, refused when it holds quotes or backslashes (a shell's word rules, which a list
/// says without doubt).
fn argv(node: Option<&Node>, what: &str) -> Result<Option<Vec<String>>, String> {
    match node {
        None | Some(Node::Null) => Ok(None),
        Some(Node::Seq(items)) => items
            .iter()
            .map(|i| {
                i.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{what}: an item that is not a value"))
            })
            .collect::<Result<_, _>>()
            .map(Some),
        Some(Node::Scalar(s)) => {
            if s.contains(['"', '\'', '\\']) {
                return Err(format!(
                    "{what} {s:?}: give it as a list; a string with quotes is a shell's to split"
                ));
            }
            Ok(Some(
                s.split_ascii_whitespace().map(str::to_owned).collect(),
            ))
        }
        Some(Node::Map(_)) => Err(format!("{what} is a mapping")),
    }
}

/// A compose duration (`60s`, `1m30s`, `3h`, `1.5s`) in whole seconds, rounded up.
fn seconds(d: &str) -> Result<u64, String> {
    let bad = || format!("stop_grace_period {d:?}: not a duration");
    let mut total_ms: f64 = 0.0;
    let mut rest = d.trim();
    if rest.is_empty() {
        return Err(bad());
    }
    if let Ok(n) = rest.parse::<u64>() {
        return Ok(n);
    }
    while !rest.is_empty() {
        let n_end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .ok_or_else(bad)?;
        let n: f64 = rest[..n_end].parse().map_err(|_| bad())?;
        rest = &rest[n_end..];
        let u_end = rest
            .find(|c: char| c.is_ascii_digit() || c == '.')
            .unwrap_or(rest.len());
        let ms = match &rest[..u_end] {
            "h" => 3_600_000.0,
            "m" => 60_000.0,
            "s" => 1000.0,
            "ms" => 1.0,
            "us" | "µs" => 0.001,
            "ns" => 0.000_001,
            _ => return Err(bad()),
        };
        total_ms += n * ms;
        rest = &rest[u_end..];
    }
    if !total_ms.is_finite() || total_ms > 1e12 {
        return Err(bad());
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok((total_ms / 1000.0).ceil() as u64)
}

/// The env files, absolute: relative to the set directory, as compose reads them; one
/// marked `required: false` that is not there is left out, as compose leaves it.
fn env_files(dir: &Path, node: Option<&Node>) -> Result<Vec<PathBuf>, String> {
    let items = match node {
        None | Some(Node::Null) => return Ok(Vec::new()),
        Some(Node::Seq(items)) => items,
        Some(_) => return Err("env_file is neither a path nor a list".into()),
    };
    let mut out = Vec::new();
    for i in items {
        let (path, required) = match i {
            Node::Scalar(s) => (s.as_str(), true),
            Node::Map(_) => (
                i.get("path")
                    .and_then(Node::as_str)
                    .ok_or("env_file: an entry without its path")?,
                i.get("required").and_then(Node::as_str) != Some("false"),
            ),
            _ => return Err("env_file: an entry that is not a path".into()),
        };
        let p = resolve(dir, path)?;
        if required || p.is_file() {
            out.push(p);
        }
    }
    Ok(out)
}

enum Mount {
    /// `Volume=`: `source:target[:options]`, or a target alone (an anonymous volume).
    Volume(String),
    Tmpfs(String),
}

/// The top-level named volumes compose would create for the project.
fn named_volumes(doc: &Node) -> Result<Vec<String>, String> {
    match doc.get("volumes") {
        None | Some(Node::Null) => Ok(Vec::new()),
        Some(Node::Map(v)) => Ok(v.iter().map(|(k, _)| k.clone()).collect()),
        Some(_) => Err("volumes is not a mapping".into()),
    }
}

fn is_volume_name(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_alphanumeric())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn volumes(
    project: &str,
    dir: &Path,
    node: Option<&Node>,
    named: &[String],
) -> Result<Vec<Mount>, String> {
    let items = match node {
        None | Some(Node::Null) => return Ok(Vec::new()),
        Some(Node::Seq(items)) => items,
        Some(_) => return Err("volumes is not a list".into()),
    };
    let source = |s: &str| -> Result<String, String> {
        if s.starts_with('/') || s.starts_with('.') {
            Ok(resolve(dir, s)?.display().to_string())
        } else if s.starts_with('~') {
            Err(format!("volume {s:?}: no home-relative bind"))
        } else if named.iter().any(|n| n == s) && is_volume_name(s) {
            // Compose's own name for a project's volume.
            Ok(format!("{project}_{s}"))
        } else {
            Err(format!(
                "volume {s:?} is not declared under the top-level volumes"
            ))
        }
    };
    let target = |t: &str| -> Result<String, String> {
        if t.starts_with('/') {
            Ok(t.to_owned())
        } else {
            Err(format!("volume target {t:?} is not an absolute path"))
        }
    };
    let mut out = Vec::new();
    for item in items {
        match item {
            Node::Scalar(spec) => {
                let parts: Vec<&str> = spec.split(':').collect();
                out.push(Mount::Volume(match parts.as_slice() {
                    [t] => target(t)?,
                    [s, t] => format!("{}:{}", source(s)?, target(t)?),
                    [s, t, opts] => {
                        for o in opts.split(',') {
                            if !matches!(o, "ro" | "rw" | "z" | "Z") {
                                return Err(format!("volume {spec:?}: option {o:?}"));
                            }
                        }
                        format!("{}:{}:{opts}", source(s)?, target(t)?)
                    }
                    _ => return Err(format!("volume {spec:?}: not source:target[:mode]")),
                }));
            }
            Node::Map(fields) => {
                for (k, _) in fields {
                    if !matches!(
                        k.as_str(),
                        "type" | "source" | "target" | "read_only" | "bind"
                    ) {
                        return Err(format!("volume {item:?}: {k} is outside the subset"));
                    }
                }
                let t = target(item.get("target").and_then(Node::as_str).unwrap_or(""))?;
                let ro = match item.get("read_only").and_then(Node::as_str) {
                    None | Some("false") => "",
                    Some("true") => ":ro",
                    Some(other) => return Err(format!("volume read_only {other:?}")),
                };
                let src = item.get("source").and_then(Node::as_str);
                out.push(match (item.get("type").and_then(Node::as_str), src) {
                    (Some("bind"), Some(s)) if s.starts_with(['/', '.']) => {
                        Mount::Volume(format!("{}:{t}{ro}", source(s)?))
                    }
                    (Some("bind"), _) => {
                        return Err(format!("volume {item:?}: a bind needs a path source"))
                    }
                    (Some("volume"), Some(s)) if !s.starts_with(['/', '.', '~']) => {
                        Mount::Volume(format!("{}:{t}{ro}", source(s)?))
                    }
                    (Some("volume"), None) if ro.is_empty() => Mount::Volume(t),
                    (Some("tmpfs"), None) => Mount::Tmpfs(t),
                    _ => return Err(format!("volume {item:?} is outside the subset")),
                });
            }
            _ => return Err(format!("volume {item:?}: not a volume")),
        }
    }
    Ok(out)
}

/// `p` as compose reads a path in the set: absolute as it is, relative from `dir`; `.`
/// components gone, and no `..` above where it starts.
fn resolve(dir: &Path, p: &str) -> Result<PathBuf, String> {
    let path = Path::new(p);
    let mut out = if path.is_absolute() {
        PathBuf::from("/")
    } else {
        dir.to_owned()
    };
    let mut depth = 0usize;
    for c in path.components() {
        match c {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(n) => {
                out.push(n);
                depth += 1;
            }
            Component::ParentDir if depth > 0 => {
                out.pop();
                depth -= 1;
            }
            Component::ParentDir | Component::Prefix(_) => {
                return Err(format!("{p:?} leaves the set directory"))
            }
        }
    }
    if !out.is_absolute() {
        return Err(format!("{p:?}: the set directory is not an absolute path"));
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests;
