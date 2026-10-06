//! `lint-set`: the host set template, and the owner's override merged onto it, against the
//! invariants of design v2 §4.3 — on the template as written, before interpolation, so a
//! secret is still a variable reference and not just a string.
//!
//! The `host` set has exactly one service, the dispatcher. It claims tasks and starts one
//! isolated, credential-less container per task; those containers and their sidecars are
//! not in the template (one function signed inside the worker image makes them, checked
//! by the dispatcher's own CI test), so nothing here describes them.
//!
//! `set.toml` beside the template is checked too ([`lint_set_toml`]): schema 3, strict,
//! naming only the template's services.
//!
//! The set's secret files (#327, design v2 §14, D15) are `run/host/<service>/token` in the
//! set directory, which the agent writes (mode 0400) for that service alone: the
//! dispatcher's host worker token reaches it as a read-only file, never as a value in its
//! environment, which `docker inspect` shows. A service may mount its own token file,
//! read-only, and nothing else there — not another service's, nor a directory that holds
//! them — and nothing mounts `OMARCHY_SECRETS_DIR` (P0). A release from before #327 reads
//! the token from `etc/dispatcher.env` and mounts no secret file: its template still passes,
//! since a rollback may name it.

mod set_toml;
pub(crate) mod yaml;

pub use set_toml::{
    lint_set_toml, parse_set_toml, service_names, Needs, Ready, SetToml, SET_SCHEMA,
};

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
    /// `OMARCHY_WORK_ROOT`, when known: what `${OMARCHY_WORK_ROOT}` names on the host.
    pub work_root: Option<PathBuf>,
    /// On a Mac (#320): the directories the `omarchy` VM mounts at their own paths. Every
    /// bind source but the socket (the VM's own) must lie under one, or the engine in the
    /// VM would bind an empty directory of its own in its place.
    pub vm_mounts: Option<Vec<PathBuf>>,
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
            work_root: None,
            vm_mounts: None,
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
            vm: Option<VmPart>,
        }
        #[derive(Deserialize)]
        struct VmPart {
            runtime: Option<String>,
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
        // The omarchy VM's mounts follow the set's paths (crate::vm::mounts): what the
        // agent starts the profile with is what the lint holds the binds to.
        let vm_mounts = match f.vm.and_then(|v| v.runtime).as_deref() {
            Some("colima") => {
                let (Some(w), Some(s), Some(d)) =
                    (&f.set.work_root, &f.set.secrets_dir, &f.set.dir)
                else {
                    return Err("agent.toml: [vm] runtime colima needs set.dir, set.work_root and set.secrets_dir, the directories its VM mounts".into());
                };
                Some(
                    crate::vm::mounts(w, s, d)
                        .into_iter()
                        .map(|m| m.path)
                        .collect(),
                )
            }
            _ => None,
        };
        Ok(Envelope {
            allow_socket: f.envelope.allow_socket,
            rootful_ack: f.envelope.rootful_ack,
            dedicated: f.envelope.dedicated,
            userns_remap: f.envelope.userns_remap,
            paths: f.envelope.paths,
            set_dir: f.set.dir,
            secrets_dir: f.set.secrets_dir,
            work_root: f.set.work_root,
            vm_mounts,
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

/// agent.toml's variables as the lint stands them in, a rootless host's as install writes
/// them: what the set may interpolate.
pub fn reference_variables() -> Vec<(String, String)> {
    [
        ("OMARCHY_WORK_ROOT", "/srv/omarchy-pool/host"),
        ("OMARCHY_SECRETS_DIR", "/srv/omarchy-pool/host-secrets"),
        ("OMARCHY_SOCKET", "/run/user/1000/podman/podman.sock"),
        ("OMARCHY_TASK_SUBNETS", crate::install::TASK_SUBNETS),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect()
}

/// The set as the Quadlet driver renders it (#330, design v2 §15, [`crate::quadlet`]): one
/// `quadlet` violation saying what it cannot render as compose would run it. The same bundle
/// serves both drivers, so `lint-set` holds every template to it, and a Quadlet host its
/// owner's override too; `variables` stand in for agent.toml's. A file that is not YAML is
/// [`lint_compose`]'s violation, not this one's.
pub fn lint_quadlet(
    template: &str,
    override_yaml: Option<&str>,
    variables: &[(String, String)],
) -> Result<(), Vec<Violation>> {
    if yaml::parse(template).is_err() || override_yaml.is_some_and(|o| yaml::parse(o).is_err()) {
        return Ok(());
    }
    let mut sources = vec![crate::quadlet::Source {
        name: "compose.yml",
        text: template,
    }];
    if let Some(text) = override_yaml {
        sources.push(crate::quadlet::Source {
            name: "compose.override.yml",
            text,
        });
    }
    crate::quadlet::render(
        "omarchy-host",
        Path::new("/srv/omarchy-pool/set"),
        &sources,
        variables,
    )
    .map(drop)
    .map_err(|e| vec![violation("quadlet", e)])
}

// ---------------------------------------------------------------------------------------
// Merging an override the way compose would, conservatively: mappings merge by key (the
// override wins), and sequences add up, so whatever either file adds is checked.

/// Service fields compose also accepts in list form, turned into mappings first so the two
/// forms merge and check alike.
pub(crate) fn normalize(doc: Node) -> Node {
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
/// Where the set's secret files are, relative to the set directory: one directory per
/// service (#327).
pub const SECRET_FILES: &str = "run/host";
/// The variable a service reads its token file's path from (#327).
pub const TOKEN_FILE_VAR: &str = "OMARCHY_WORKER_TOKEN_FILE";

/// A service's own token file, relative to the set directory: the only secret file it may
/// mount (#327).
pub fn token_file_of(service: &str) -> String {
    format!("{SECRET_FILES}/{service}/token")
}

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
    TOKEN_FILE_VAR,
];
/// The build images every task container starts from (#312), each as its placeholder: the
/// release renders it to the manifest's digest (`inner.images.build`). Missing, empty, a
/// tag or any other value would leave pkg-repo on an unpinned tag, so all are refused.
const BUILD_IMAGES: &[(&str, &str)] = &[
    ("OMARCHY_BUILD_IMAGE_AARCH64", "@BUILD_AARCH64@"),
    ("OMARCHY_BUILD_IMAGE_X86_64", "@BUILD_X86_64@"),
];

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
    for (key, placeholder) in BUILD_IMAGES {
        let value = env.and_then(|e| e.get(key));
        if value.and_then(Node::as_str) != Some(*placeholder) {
            out.push(violation(
                "build_images",
                format!(
                    "{name}: the dispatcher must carry {key}: \"{placeholder}\", found {value:?}"
                ),
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
        // (source, target, read-only) of a host bind; named and anonymous volumes and tmpfs
        // pass.
        let bind: Option<(&str, &str, bool)> = match item {
            Node::Scalar(spec) => match split_short(spec).as_slice() {
                [_target] => None,
                [source, target] => short_bind(source).then_some((*source, *target, false)),
                [source, target, mode] => {
                    short_bind(source).then_some((*source, *target, read_only_mode(mode)))
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
                let read_only = item.get("read_only").and_then(Node::as_str) == Some("true");
                match (kind, item.get("source").and_then(Node::as_str)) {
                    (Some("bind"), Some(source)) => Some((source, target, read_only)),
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
        if let Some((source, target, read_only)) = bind {
            check_bind(name, (source, target, read_only), envelope, engine, out);
        }
    }
}

/// Whether a short-syntax volume's mode mounts it read-only: as compose reads it, the last
/// of `ro` and `rw` wins (`ro,rw` is writable).
fn read_only_mode(mode: &str) -> bool {
    mode.split(',').rev().find(|o| matches!(*o, "ro" | "rw")) == Some("ro")
}

/// Whether a short-syntax volume's source is a host path (not a named volume).
fn short_bind(source: &str) -> bool {
    source.starts_with(['/', '.', '~', '$']) || source.contains('/')
}

fn check_bind(
    name: &str,
    (source, target, read_only): (&str, &str, bool),
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
        let rest = source.strip_prefix(&format!("${{{WORK_ROOT_VAR}}}/"));
        let under = rest.is_some_and(|rest| is_relative_inside(Path::new(rest)));
        if !(single && (whole || under)) {
            out.push(violation("bind_path", format!("{name}: {source:?}: a bind source may only be ${{{SOCKET_VAR}}}, ${{{WORK_ROOT_VAR}}} or a path under it")));
        } else if refs[0].name == WORK_ROOT_VAR {
            // The socket is the VM's own; the work root is a path on the Mac.
            let host = envelope
                .work_root
                .as_ref()
                .map(|w| rest.map_or_else(|| w.clone(), |r| w.join(r)));
            check_vm_mount(name, source, host.as_deref(), envelope, out);
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
        if check_absolute_secret_file(name, source, path, read_only, envelope, out) {
            return;
        }
        let allowed = envelope
            .paths
            .iter()
            .chain(&envelope.set_dir)
            .any(|p| path.starts_with(p));
        if !allowed {
            out.push(violation("bind_path", format!("{name}: {source:?} is neither in the set directory nor under a path the envelope lists")));
        }
        check_vm_mount(name, source, Some(path), envelope, out);
    } else if let Some(rel) = normalized(path) {
        // Inside the set directory: its secret files first (#327), then the VM's mounts
        // (#320), as an absolute path in it goes.
        if !check_secret_file(name, source, &rel, read_only, out) {
            let host = envelope.set_dir.as_ref().map(|d| d.join(path));
            check_vm_mount(name, source, host.as_deref(), envelope, out);
        }
    } else {
        out.push(violation(
            "bind_path",
            format!("{name}: {source:?} leaves the set directory"),
        ));
    }
}

/// On a Mac (#320): a bind source must lie under a directory the `omarchy` VM mounts at
/// its own path, or the engine in the VM binds an empty directory of its own instead.
fn check_vm_mount(
    name: &str,
    source: &str,
    host: Option<&Path>,
    envelope: &Envelope,
    out: &mut Vec<Violation>,
) {
    let Some(mounts) = &envelope.vm_mounts else {
        return;
    };
    let under = host.is_some_and(|h| {
        let h: PathBuf = h
            .components()
            .filter(|c| !matches!(c, Component::CurDir))
            .collect();
        mounts.iter().any(|m| h.starts_with(m))
    });
    if !under {
        out.push(violation(
            "vm_mount",
            format!(
                "{name}: {source:?}{} lies under no directory the omarchy VM mounts ({})",
                host.map_or_else(String::new, |h| format!(" ({})", h.display())),
                mounts
                    .iter()
                    .map(|m| m.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
}

/// An absolute bind source against the set's secret files (#327): one in the envelope's set
/// directory is checked as the path relative to it, and one that holds them is refused.
/// `true` when it was refused.
fn check_absolute_secret_file(
    name: &str,
    source: &str,
    path: &Path,
    read_only: bool,
    envelope: &Envelope,
    out: &mut Vec<Violation>,
) -> bool {
    let Some(set) = &envelope.set_dir else {
        return false;
    };
    match path.strip_prefix(set) {
        Ok(rel) => check_secret_file(name, source, rel, read_only, out),
        Err(_) if set.join(SECRET_FILES).starts_with(path) => {
            out.push(holds_secret_files(name, source));
            true
        }
        Err(_) => false,
    }
}

/// A bind of `rel` (relative to the set directory) against the set's secret files: a
/// service's own token file read-only passes; anything else under them, or a directory
/// that holds them, is refused. `true` when it was refused.
fn check_secret_file(
    name: &str,
    source: &str,
    rel: &Path,
    read_only: bool,
    out: &mut Vec<Violation>,
) -> bool {
    let root = Path::new(SECRET_FILES);
    if rel == Path::new(&token_file_of(name)) {
        if read_only {
            return false;
        }
        out.push(violation(
            "secret_file",
            format!("{name}: {source:?} is its token file, which it mounts read-only only"),
        ));
    } else if rel.starts_with(root) {
        out.push(violation(
            "secret_file",
            format!(
                "{name}: {source:?} is under {SECRET_FILES}/, the set's secret files: a service mounts its own token file only, {}",
                token_file_of(name)
            ),
        ));
    } else if root.starts_with(rel) {
        out.push(holds_secret_files(name, source));
    } else {
        return false;
    }
    true
}

fn holds_secret_files(name: &str, source: &str) -> Violation {
    violation(
        "secret_file",
        format!("{name}: {source:?} holds {SECRET_FILES}/, the set's secret files (every service's token)"),
    )
}

/// A relative path with `.` and `..` resolved; `None` when it leaves its base.
fn normalized(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::Normal(p) => out.push(p),
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------------------
// What the run loop reads of a template (#327).

fn services_of(template: &str) -> Vec<(String, Node)> {
    let Ok(node @ Node::Map(_)) = yaml::parse(template) else {
        return Vec::new();
    };
    match normalize(node).get("services") {
        Some(Node::Map(entries)) => entries.clone(),
        _ => Vec::new(),
    }
}

/// Whether every service of a template reads the host worker token from its file (#327):
/// [`TOKEN_FILE_VAR`] in its environment. A release from before #327 reads
/// `OMARCHY_WORKER_TOKEN` from `etc/dispatcher.env`, where the agent then keeps the token
/// too; a template that does not parse reads as one of those.
pub fn reads_token_file(template: &str) -> bool {
    let services = services_of(template);
    !services.is_empty()
        && services.iter().all(|(_, s)| {
            s.get("environment")
                .and_then(|e| e.get(TOKEN_FILE_VAR))
                .is_some()
        })
}

/// The secret files a template mounts, relative to the set directory (#327): what the
/// agent must have written before compose creates the service, which would otherwise make
/// a directory where the file belongs.
pub fn secret_files(template: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, service) in services_of(template) {
        let Some(Node::Seq(items)) = service.get("volumes") else {
            continue;
        };
        for item in items {
            let source = match item {
                Node::Scalar(spec) => match split_short(spec).as_slice() {
                    [source, _] | [source, _, _] => Some(*source),
                    _ => None,
                },
                Node::Map(_) => item.get("source").and_then(Node::as_str),
                _ => None,
            };
            let rel = source
                .filter(|s| !s.starts_with(['/', '~', '$']))
                .and_then(|s| normalized(Path::new(s)))
                .filter(|r| r.starts_with(SECRET_FILES));
            if let Some(r) = rel.and_then(|r| r.to_str().map(str::to_owned)) {
                if !out.contains(&r) {
                    out.push(r);
                }
            }
        }
    }
    out
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

pub(crate) fn is_plain_absolute(path: &Path) -> bool {
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
