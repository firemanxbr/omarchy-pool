//! `lint-set`: the host set template, and the owner's override merged onto it, against the
//! invariants of design v2 §4.3 — on the template as written, before interpolation, so a
//! secret is still a variable reference and not just a string.
//!
//! The `host` set has exactly one service, the dispatcher. It claims tasks and starts one
//! isolated, credential-less container per task; those containers and their sidecars are
//! not in the template (one function signed inside the worker image makes them, checked
//! by the dispatcher's own CI test), so nothing here describes them.

mod yaml;

use std::fmt;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use yaml::Node;

/// One broken invariant: a stable rule name and what was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub rule: &'static str,
    pub message: String,
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.rule, self.message)
    }
}

fn violation(rule: &'static str, message: impl Into<String>) -> Violation {
    Violation {
        rule,
        message: message.into(),
    }
}

/// What the owner's envelope (`agent.toml`, design v2 §12) allows the set.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // agent.toml's own [envelope] switches, one for one
pub struct Envelope {
    pub allow_socket: bool,
    pub rootful_ack: bool,
    pub dedicated: bool,
    pub userns_remap: bool,
    /// Host paths a bind mount may name, besides the set directory.
    pub paths: Vec<PathBuf>,
    /// The set directory, when known (relative binds are inside it by construction).
    pub set_dir: Option<PathBuf>,
    /// `OMARCHY_SECRETS_DIR`, when known: never mounted, nor any directory holding it.
    pub secrets_dir: Option<PathBuf>,
}

impl Envelope {
    /// The envelope every host of the `host` set must have (design v2 §12): the dispatcher
    /// holds the socket (`allow_socket`, and `rootful_ack` with `dedicated` for a rootful
    /// engine), no user-namespace exception, and no host path beyond the set's own
    /// variables. CI lints the template against it; a host lints with its own.
    pub fn reference() -> Self {
        Envelope {
            allow_socket: true,
            rootful_ack: true,
            dedicated: true,
            userns_remap: false,
            paths: Vec::new(),
            set_dir: None,
            secrets_dir: None,
        }
    }

    /// The parts of `agent.toml` the lint needs. Unknown keys are left to the run loop
    /// (P1); a missing permission is `false`. The secrets directory must be outside the
    /// work root and the set directory (design v2 §4.2), since the template binds both.
    pub fn from_agent_toml(text: &str) -> Result<Self, String> {
        #[derive(Deserialize, Default)]
        struct File {
            #[serde(default)]
            set: SetPart,
            #[serde(default)]
            envelope: EnvelopePart,
        }
        #[derive(Deserialize, Default)]
        struct SetPart {
            dir: Option<PathBuf>,
            work_root: Option<PathBuf>,
            secrets_dir: Option<PathBuf>,
        }
        #[derive(Deserialize, Default)]
        #[allow(clippy::struct_excessive_bools)]
        struct EnvelopePart {
            #[serde(default)]
            allow_socket: bool,
            #[serde(default)]
            rootful_ack: bool,
            #[serde(default)]
            dedicated: bool,
            #[serde(default)]
            userns_remap: bool,
            #[serde(default)]
            paths: Vec<PathBuf>,
        }
        let f: File = toml::from_str(text).map_err(|e| format!("agent.toml: {e}"))?;
        for p in f
            .envelope
            .paths
            .iter()
            .chain(&f.set.dir)
            .chain(&f.set.work_root)
            .chain(&f.set.secrets_dir)
        {
            if !is_plain_absolute(p) {
                return Err(format!(
                    "agent.toml: {} is not a plain absolute path",
                    p.display()
                ));
            }
        }
        if let Some(secrets) = &f.set.secrets_dir {
            for (key, dir) in [("work_root", &f.set.work_root), ("dir", &f.set.dir)] {
                if let Some(d) = dir
                    .as_ref()
                    .filter(|d| d.starts_with(secrets) || secrets.starts_with(d))
                {
                    return Err(format!(
                        "agent.toml: set.secrets_dir {} overlaps set.{key} {}; it must be outside both",
                        secrets.display(),
                        d.display()
                    ));
                }
            }
        }
        Ok(Envelope {
            allow_socket: f.envelope.allow_socket,
            rootful_ack: f.envelope.rootful_ack,
            dedicated: f.envelope.dedicated,
            userns_remap: f.envelope.userns_remap,
            paths: f.envelope.paths,
            set_dir: f.set.dir,
            secrets_dir: f.set.secrets_dir,
        })
    }
}

/// The engine the set runs on, as far as the lint cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// A root daemon: the socket makes the dispatcher root-equivalent.
    Rootful,
    Rootless,
}

/// Lints a set's `compose.yml` as written, and the override merged onto it, with the same
/// rules. The caller reads the files, so a file that cannot be read is its error, not a
/// violation.
pub fn lint_compose(
    template: &str,
    override_yaml: Option<&str>,
    envelope: &Envelope,
    engine: Engine,
) -> Result<(), Vec<Violation>> {
    let load = |what: &str, src: &str| -> Result<Node, Vec<Violation>> {
        let node = yaml::parse(src).map_err(|e| vec![violation("yaml", format!("{what}: {e}"))])?;
        let Node::Map(_) = node else {
            return Err(vec![violation("yaml", format!("{what}: not a mapping"))]);
        };
        Ok(normalize(node))
    };
    let mut doc = load("compose.yml", template)?;
    if let Some(src) = override_yaml {
        doc = merge(doc, load("compose.override.yml", src)?);
    }
    let mut out = Vec::new();
    check(&doc, envelope, engine, &mut out);
    if out.is_empty() {
        Ok(())
    } else {
        Err(out)
    }
}

// ---------------------------------------------------------------------------------------
// Merging an override the way compose would, conservatively: mappings merge by key (the
// override wins), and sequences add up, so whatever either file adds is checked.

/// Service fields compose also accepts in list form, turned into mappings first so the two
/// forms merge and check alike.
fn normalize(doc: Node) -> Node {
    map_entries(doc, |key, value| match key {
        "services" => map_entries(value, |_, service| {
            map_entries(service, |field, v| match field {
                "environment" | "labels" => list_to_map(v, '='),
                "networks" => list_to_map(v, '\0'),
                "env_file" => match v {
                    Node::Seq(_) => v,
                    other => Node::Seq(vec![other]),
                },
                _ => v,
            })
        }),
        _ => value,
    })
}

fn map_entries(node: Node, f: impl Fn(&str, Node) -> Node) -> Node {
    match node {
        Node::Map(entries) => Node::Map(
            entries
                .into_iter()
                .map(|(k, v)| {
                    let v = f(&k, v);
                    (k, v)
                })
                .collect(),
        ),
        other => other,
    }
}

/// `["K=v", "K2"]` into `{K: v, K2: null}`; anything else is left for the checks.
fn list_to_map(node: Node, sep: char) -> Node {
    let Node::Seq(items) = node else { return node };
    let mut entries: Vec<(String, Node)> = Vec::new();
    for item in items {
        let Node::Scalar(s) = item else {
            return Node::Seq(vec![item]);
        };
        let (k, v) = match s.split_once(sep) {
            Some((k, v)) => (k.to_owned(), Node::Scalar(v.to_owned())),
            None => (s, Node::Null),
        };
        entries.retain(|(e, _)| *e != k);
        entries.push((k, v));
    }
    Node::Map(entries)
}

fn merge(base: Node, over: Node) -> Node {
    match (base, over) {
        (Node::Map(mut b), Node::Map(o)) => {
            for (k, v) in o {
                match b.iter().position(|(e, _)| *e == k) {
                    Some(i) => {
                        let old = std::mem::replace(&mut b[i].1, Node::Null);
                        b[i].1 = merge(old, v);
                    }
                    None => b.push((k, v)),
                }
            }
            Node::Map(b)
        }
        (Node::Seq(mut b), Node::Seq(o)) => {
            b.extend(o);
            Node::Seq(b)
        }
        (_, over) => over,
    }
}

// ---------------------------------------------------------------------------------------
// The rules.

const ROLE_LABEL: &str = "org.omarchy-pool.role";
const ROLE: &str = "dispatcher";
const WORKER_REPO: &str = "ghcr.io/firemanxbr/omarchy-worker";
const ENV_FILE: &str = "etc/dispatcher.env";

/// v1 §4.3's allowed service fields, plus `userns_mode` (checked on its own).
const FIELDS: &[&str] = &[
    "image",
    "platform",
    "profiles",
    "environment",
    "env_file",
    "volumes",
    "networks",
    "restart",
    "stop_grace_period",
    "stop_signal",
    "security_opt",
    "labels",
    "depends_on",
    "command",
    "entrypoint",
    "user",
    "userns_mode",
];

/// Named refusals, for a clearer message than "not allowed".
const REFUSED: &[(&str, &str)] = &[
    ("build", "an image is only ever the release's, by digest"),
    ("ports", "a host listens on nothing"),
    ("devices", "no host device reaches the dispatcher"),
    ("privileged", "never privileged"),
    ("cap_add", "no added capability"),
    ("pid", "no shared PID namespace"),
    ("ipc", "no shared IPC namespace"),
    ("network_mode", "no host or shared network namespace"),
];

/// The dispatcher's environment (design v2 §4.2).
const ENVIRONMENT: &[&str] = &[
    "OMARCHY_WORKER_ROLE",
    "OMARCHY_WORK_ROOT",
    "OMARCHY_SECRETS_DIR",
    "OMARCHY_CAPACITY_FILE",
    "OMARCHY_BUILD_IMAGE_AARCH64",
    "OMARCHY_BUILD_IMAGE_X86_64",
    "OMARCHY_WORKER_IMAGE",
    "OMARCHY_TASK_SUBNETS",
];
const BUILD_IMAGES: &[&str] = &["OMARCHY_BUILD_IMAGE_AARCH64", "OMARCHY_BUILD_IMAGE_X86_64"];

/// Agent keys and the GitHub token: never interpolated into the set, anywhere.
fn is_secret_variable(name: &str) -> bool {
    ["ANTHROPIC_", "OPENAI_", "GEMINI_", "XAI_"]
        .iter()
        .any(|p| name.starts_with(p))
        || matches!(name, "CLAUDE_CODE_OAUTH_TOKEN" | "GITHUB_TOKEN")
}

fn check(doc: &Node, envelope: &Envelope, engine: Engine, out: &mut Vec<Violation>) {
    let Node::Map(top) = doc else { return };
    for (key, value) in top {
        match key.as_str() {
            "services" => {}
            "networks" => check_networks(value, out),
            "volumes" => check_named_volumes(value, out),
            k if k.starts_with("x-") => {}
            k => out.push(violation(
                "top_level",
                format!("{k:?} is not in the template subset"),
            )),
        }
    }
    check_interpolation(doc, out);
    let Some(Node::Map(services)) = doc.get("services") else {
        out.push(violation("services", "no services mapping"));
        return;
    };
    if services.len() != 1 {
        let names: Vec<&str> = services.iter().map(|(n, _)| n.as_str()).collect();
        out.push(violation(
            "services",
            format!("the host set has exactly one service, the dispatcher; found {names:?}"),
        ));
    }
    for (name, service) in services {
        check_service(name, service, envelope, engine, out);
    }
}

fn check_service(
    name: &str,
    service: &Node,
    envelope: &Envelope,
    engine: Engine,
    out: &mut Vec<Violation>,
) {
    let Node::Map(fields) = service else {
        out.push(violation("services", format!("{name}: not a mapping")));
        return;
    };
    let role = service
        .get("labels")
        .and_then(|l| l.get(ROLE_LABEL))
        .and_then(Node::as_str);
    if role != Some(ROLE) {
        out.push(violation(
            "role",
            format!("{name}: {ROLE_LABEL} must be {ROLE:?}, found {role:?}"),
        ));
    }
    for (field, value) in fields {
        if let Some((_, why)) = REFUSED.iter().find(|(f, _)| f == field) {
            out.push(violation(
                "field",
                format!("{name}: {field} is refused ({why})"),
            ));
        } else if !FIELDS.contains(&field.as_str()) && !field.starts_with("x-") {
            out.push(violation(
                "field",
                format!("{name}: {field} is not in the template subset"),
            ));
        } else {
            match field.as_str() {
                "image" => check_image(name, value, out),
                "userns_mode" => {
                    if value.as_str() != Some("host") || !envelope.userns_remap {
                        out.push(violation(
                            "userns_mode",
                            format!("{name}: userns_mode is refused except `host` when the envelope records userns_remap = true"),
                        ));
                    }
                }
                "security_opt" => check_security_opt(name, value, out),
                "env_file" => check_env_file(name, value, out),
                "environment" => check_environment(name, value, out),
                "volumes" => check_volumes(name, value, envelope, engine, out),
                "labels" => check_labels(name, value, out),
                _ => {}
            }
        }
    }
    if service.get("image").is_none() {
        out.push(violation("image", format!("{name}: no image")));
    }
    let env = service.get("environment");
    for key in BUILD_IMAGES {
        if env.and_then(|e| e.get(key)).is_none() {
            out.push(violation(
                "build_images",
                format!("{name}: the dispatcher must carry {key}"),
            ));
        }
    }
}

fn check_labels(name: &str, value: &Node, out: &mut Vec<Violation>) {
    if !matches!(value, Node::Map(_)) {
        out.push(violation(
            "role",
            format!("{name}: labels are not a mapping"),
        ));
    }
}

/// The worker image or one of the manifest's build images, only as placeholders: the lint
/// runs before the placeholders are rendered to the verified manifest's digests, so a
/// literal digest (an older or revoked image, say) is refused, in the template and in an
/// override alike.
fn check_image(name: &str, value: &Node, out: &mut Vec<Violation>) {
    let release = format!("{WORKER_REPO}@RELEASE@");
    let ok = value
        .as_str()
        .is_some_and(|i| i == release || matches!(i, "@BUILD_AARCH64@" | "@BUILD_X86_64@"));
    if !ok {
        out.push(violation(
            "image",
            format!("{name}: image must be {release} or a manifest build image placeholder, found {value:?}"),
        ));
    }
}

fn check_security_opt(name: &str, value: &Node, out: &mut Vec<Violation>) {
    let ok = matches!(value, Node::Seq(items) if items.iter().all(|i| matches!(i.as_str(), Some("label=disable" | "label:disable"))));
    if !ok {
        out.push(violation(
            "field",
            format!("{name}: security_opt may only be label=disable"),
        ));
    }
}

fn check_env_file(name: &str, value: &Node, out: &mut Vec<Violation>) {
    let items = match value {
        Node::Seq(items) => items.as_slice(),
        other => std::slice::from_ref(other),
    };
    for item in items {
        let path = match item {
            Node::Scalar(s) => Some(s.as_str()),
            Node::Map(_) => {
                let only_known = matches!(item, Node::Map(e) if e.iter().all(|(k, _)| k == "path" || k == "required"));
                item.get("path")
                    .and_then(Node::as_str)
                    .filter(|_| only_known)
            }
            _ => None,
        };
        if !matches!(path, Some(p) if p == ENV_FILE || p.strip_prefix("./") == Some(ENV_FILE)) {
            out.push(violation(
                "env_file",
                format!("{name}: env_file may only be {ENV_FILE}, found {item:?}"),
            ));
        }
    }
}

fn check_environment(name: &str, value: &Node, out: &mut Vec<Violation>) {
    let Node::Map(entries) = value else {
        out.push(violation(
            "environment",
            format!("{name}: environment is neither a mapping nor a list"),
        ));
        return;
    };
    for (key, _) in entries {
        if !ENVIRONMENT.contains(&key.as_str()) {
            let secret = if is_secret_variable(key) {
                " (an agent key or the GitHub token)"
            } else {
                ""
            };
            out.push(violation(
                "environment",
                format!("{name}: {key} is not an allowed dispatcher variable{secret}"),
            ));
        }
    }
}

fn check_networks(value: &Node, out: &mut Vec<Violation>) {
    let Node::Map(nets) = value else {
        out.push(violation("network", "networks is not a mapping"));
        return;
    };
    for (net, def) in nets {
        let ok = match def {
            Node::Null => true,
            Node::Map(fields) => fields.iter().all(|(k, v)| match k.as_str() {
                "driver" => v.as_str() == Some("bridge"),
                "internal" => matches!(v.as_str(), Some("true" | "false")),
                "labels" => true,
                _ => false,
            }),
            _ => false,
        };
        if !ok {
            out.push(violation(
                "network",
                format!("network {net}: only a bridge (driver, internal, labels)"),
            ));
        }
    }
}

fn check_named_volumes(value: &Node, out: &mut Vec<Violation>) {
    let Node::Map(vols) = value else {
        out.push(violation("volume", "volumes is not a mapping"));
        return;
    };
    for (vol, def) in vols {
        // A driver, driver_opts, name or external could make a named volume a bind of any
        // host path, or another project's volume.
        let ok = match def {
            Node::Null => true,
            Node::Map(fields) => fields.iter().all(|(k, _)| k == "labels"),
            _ => false,
        };
        if !ok {
            out.push(violation(
                "volume",
                format!("volume {vol}: only labels (no driver, name or external)"),
            ));
        }
    }
}

// ---------------------------------------------------------------------------------------
// Variable references, before interpolation.

/// A `$NAME` or `${NAME...}` reference compose would interpolate (`$$` is a literal `$`).
#[derive(Debug, PartialEq, Eq)]
struct Reference<'a> {
    name: &'a str,
    /// `${NAME}` or `$NAME` with nothing else (no default, no error, no alternative).
    plain: bool,
}

fn references(s: &str) -> Vec<Reference<'_>> {
    let b = s.as_bytes();
    let name_char = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'$' {
            i += 1;
            continue;
        }
        match b.get(i + 1) {
            Some(b'$') => i += 2,
            Some(b'{') => {
                let start = i + 2;
                let mut end = start;
                while end < b.len() && name_char(b[end]) {
                    end += 1;
                }
                out.push(Reference {
                    name: &s[start..end],
                    plain: b.get(end) == Some(&b'}'),
                });
                // Keep scanning inside: a default can hold a reference of its own.
                i = start;
            }
            Some(&c) if name_char(c) => {
                let start = i + 1;
                let mut end = start;
                while end < b.len() && name_char(b[end]) {
                    end += 1;
                }
                out.push(Reference {
                    name: &s[start..end],
                    plain: true,
                });
                i = end;
            }
            _ => i += 1,
        }
    }
    out
}

fn check_interpolation(node: &Node, out: &mut Vec<Violation>) {
    fn walk(node: &Node, scan: &mut dyn FnMut(&str)) {
        match node {
            Node::Null => {}
            Node::Scalar(s) => scan(s),
            Node::Seq(items) => items.iter().for_each(|i| walk(i, scan)),
            Node::Map(entries) => {
                for (k, v) in entries {
                    scan(k);
                    walk(v, scan);
                }
            }
        }
    }
    let mut scan = |s: &str| {
        for r in references(s) {
            if is_secret_variable(r.name) {
                out.push(violation(
                    "secret_interpolation",
                    format!("${{{}}} is interpolated: agent keys and the GitHub token never reach the set", r.name),
                ));
            }
        }
    };
    walk(node, &mut scan);
}

// ---------------------------------------------------------------------------------------
// Mounts.

const SOCKET_VAR: &str = "OMARCHY_SOCKET";
const WORK_ROOT_VAR: &str = "OMARCHY_WORK_ROOT";
const SECRETS_VAR: &str = "OMARCHY_SECRETS_DIR";

/// Splits a short-syntax volume at `:`, but not inside `${...}`.
fn split_short(spec: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0usize, 0);
    let b = spec.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'{' if i > 0 && b[i - 1] == b'$' => depth += 1,
            b'}' if depth > 0 => depth -= 1,
            b':' if depth == 0 => {
                parts.push(&spec[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&spec[start..]);
    parts
}

fn check_volumes(
    name: &str,
    value: &Node,
    envelope: &Envelope,
    engine: Engine,
    out: &mut Vec<Violation>,
) {
    let Node::Seq(items) = value else {
        out.push(violation(
            "bind_path",
            format!("{name}: volumes is not a list"),
        ));
        return;
    };
    for item in items {
        // (source, target) of a host bind; named and anonymous volumes and tmpfs pass.
        let bind: Option<(&str, &str)> = match item {
            Node::Scalar(spec) => match split_short(spec).as_slice() {
                [_target] => None,
                [source, target] | [source, target, _] => {
                    let path_like =
                        source.starts_with(['/', '.', '~', '$']) || source.contains('/');
                    path_like.then_some((*source, *target))
                }
                _ => {
                    out.push(violation(
                        "bind_path",
                        format!("{name}: cannot read volume {spec:?}"),
                    ));
                    continue;
                }
            },
            Node::Map(fields) => {
                let known = fields.iter().all(|(k, v)| match k.as_str() {
                    "type" | "source" | "target" | "read_only" => true,
                    "bind" => {
                        matches!(v, Node::Map(b) if b.iter().all(|(k, _)| k == "create_host_path"))
                    }
                    _ => false,
                });
                let kind = item.get("type").and_then(Node::as_str);
                if !known || !matches!(kind, Some("bind" | "volume" | "tmpfs")) {
                    out.push(violation(
                        "bind_path",
                        format!("{name}: volume {item:?} is outside the template subset"),
                    ));
                    continue;
                }
                let target = item.get("target").and_then(Node::as_str).unwrap_or("");
                match (kind, item.get("source").and_then(Node::as_str)) {
                    (Some("bind"), Some(source)) => Some((source, target)),
                    (Some("bind"), None) => {
                        out.push(violation(
                            "bind_path",
                            format!("{name}: a bind without a source"),
                        ));
                        continue;
                    }
                    _ => None,
                }
            }
            _ => {
                out.push(violation(
                    "bind_path",
                    format!("{name}: cannot read volume {item:?}"),
                ));
                continue;
            }
        };
        if let Some((source, target)) = bind {
            check_bind(name, source, target, envelope, engine, out);
        }
    }
}

fn check_bind(
    name: &str,
    source: &str,
    target: &str,
    envelope: &Envelope,
    engine: Engine,
    out: &mut Vec<Violation>,
) {
    let refs = references(source);
    if refs.iter().any(|r| r.name == SECRETS_VAR) {
        out.push(violation("secrets_mount", format!("{name}: {source:?} mounts OMARCHY_SECRETS_DIR; agent keys reach only per-task agent sidecars")));
        return;
    }
    let socket_ref = refs.iter().any(|r| r.name == SOCKET_VAR);
    let is_socket = socket_ref
        || [source, target].iter().any(|p| {
            Path::new(p)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("sock"))
        })
        || matches!(
            target,
            "/var/run/docker.sock" | "/run/docker.sock" | "/run/podman/podman.sock"
        );
    if is_socket {
        let allowed = envelope.allow_socket
            && (engine == Engine::Rootless || (envelope.rootful_ack && envelope.dedicated));
        if !allowed {
            let need = match engine {
                Engine::Rootful => "allow_socket, rootful_ack and dedicated",
                Engine::Rootless => "allow_socket",
            };
            out.push(violation(
                "socket",
                format!(
                    "{name}: {source:?} mounts the runtime socket; the envelope must have {need}"
                ),
            ));
        }
    }
    if !refs.is_empty() {
        // The only host paths a variable may name: the socket and the work root, whose
        // values come from the envelope. `${VAR:-/}` could fall back to anything.
        let single = refs.len() == 1
            && refs[0].plain
            && (refs[0].name == SOCKET_VAR || refs[0].name == WORK_ROOT_VAR);
        let whole =
            source == format!("${{{}}}", refs[0].name) || source == format!("${}", refs[0].name);
        let under = source
            .strip_prefix(&format!("${{{WORK_ROOT_VAR}}}/"))
            .is_some_and(|rest| is_relative_inside(Path::new(rest)));
        if !(single && (whole || under)) {
            out.push(violation("bind_path", format!("{name}: {source:?}: a bind source may only be ${{{SOCKET_VAR}}}, ${{{WORK_ROOT_VAR}}} or a path under it")));
        }
        return;
    }
    let path = Path::new(source);
    if source.starts_with('~') {
        out.push(violation(
            "bind_path",
            format!("{name}: {source:?}: no home-relative bind"),
        ));
    } else if path.is_absolute() {
        if !is_plain_absolute(path) {
            out.push(violation(
                "bind_path",
                format!("{name}: {source:?} is not a plain absolute path"),
            ));
            return;
        }
        if let Some(secrets) = &envelope.secrets_dir {
            if path.starts_with(secrets) || secrets.starts_with(path) {
                out.push(violation(
                    "secrets_mount",
                    format!("{name}: {source:?} holds or is within the secrets directory"),
                ));
                return;
            }
        }
        let allowed = envelope
            .paths
            .iter()
            .chain(&envelope.set_dir)
            .any(|p| path.starts_with(p));
        if !allowed {
            out.push(violation("bind_path", format!("{name}: {source:?} is neither in the set directory nor under a path the envelope lists")));
        }
    } else if !is_relative_inside(path) {
        out.push(violation(
            "bind_path",
            format!("{name}: {source:?} leaves the set directory"),
        ));
    }
}

/// A relative path that stays inside its base, component by component.
fn is_relative_inside(path: &Path) -> bool {
    let mut depth = 0usize;
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::Normal(_) => depth += 1,
            Component::ParentDir => match depth.checked_sub(1) {
                Some(d) => depth = d,
                None => return false,
            },
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    true
}

fn is_plain_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}

#[cfg(feature = "fuzzing")]
pub(crate) fn fuzz(template: &str, override_yaml: Option<&str>) {
    let _ = lint_compose(
        template,
        override_yaml,
        &Envelope::reference(),
        Engine::Rootful,
    );
}

#[cfg(test)]
mod tests;
