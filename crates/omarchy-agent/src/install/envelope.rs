//! `agent.toml` as install writes it (#317, design v2 §12, §13.2 step 5): from detection
//! and the flags, printed for the person to confirm before anything is written, and
//! written with the host's `host_id` and `worker_id` once the owner confirmed it (#321):
//! until then there is no agent.toml, so no run loop and no dispatcher, and nothing
//! claims.
//!
//! Re-running install keeps an existing agent.toml: what install owns is set again (the
//! ids, the set's paths and socket, the detected permissions), a flag given again
//! replaces its key, and every other key — the owner's caps and settings — stays.

use std::path::{Path, PathBuf};

use toml::{Table, Value};

/// What install decides; `None` keeps an existing file's value (or leaves the key out).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Values {
    pub pool: String,
    pub set_dir: PathBuf,
    pub work_root: PathBuf,
    pub secrets_dir: PathBuf,
    /// The engine's socket for the agent's CLI (`set.socket_cli`), and the one the
    /// dispatcher bind-mounts (`set.socket_mount`): the same on Linux; on a Mac the VM's
    /// own `/var/run/docker.sock`.
    pub socket: PathBuf,
    pub socket_mount: PathBuf,
    pub task_subnets: String,
    /// A rootful daemon behind the socket: the owner acknowledges root-equivalence by
    /// confirming the envelope (or with `--yes`).
    pub rootful: bool,
    /// Rootful with `userns-remap`: the dispatcher alone runs with `userns_mode: host`.
    pub userns_remap: bool,
    pub dedicated: bool,
    pub max_units: Option<u32>,
    pub max_cpus: Option<u32>,
    pub max_mem_gb: Option<u32>,
    /// A Mac's VM (#320): `[vm]`.
    pub vm: Option<Vm>,
}

/// `[vm]` on a Mac (#320, design v2 §19.2): the runtime the engine is in — `colima` (the
/// `omarchy` profile the agent starts, stops and sizes from the envelope's `max_cpus` and
/// `max_mem_gb`), or `docker-desktop` / `orbstack` (used because they are here, never
/// managed) — whether its VM runs `x86_64` through Rosetta, and its disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Vm {
    pub runtime: &'static str,
    pub rosetta: bool,
    pub disk_gb: u32,
    /// The omarchy VM's size, written as the envelope's caps.
    pub size: Option<crate::vm::Size>,
}

/// The default project of the host set (`set.toml`'s `project_default`).
pub(crate) const PROJECT: &str = "omarchy-host";

fn table<'a>(t: &'a mut Table, key: &str) -> &'a mut Table {
    if !t.get(key).is_some_and(Value::is_table) {
        t.insert(key.to_owned(), Value::Table(Table::new()));
    }
    t.get_mut(key)
        .and_then(Value::as_table_mut)
        .expect("a table")
}

fn path(p: &Path) -> Value {
    Value::String(p.display().to_string())
}

/// The envelope: `existing` (agent.toml's text, when there is one) with install's keys
/// set; the ids when the owner has confirmed the host.
pub(crate) fn render(
    existing: Option<&str>,
    v: &Values,
    ids: Option<(&str, &str)>,
) -> Result<String, String> {
    let mut t: Table = match existing {
        Some(text) => toml::from_str(text).map_err(|e| format!("agent.toml: {e}"))?,
        None => Table::new(),
    };
    t.insert("pool".into(), Value::String(v.pool.clone()));
    if let Some((host, worker)) = ids {
        t.insert("host_id".into(), Value::String(host.to_owned()));
        t.insert("worker_id".into(), Value::String(worker.to_owned()));
    } else {
        t.remove("host_id");
        t.remove("worker_id");
    }
    let set = table(&mut t, "set");
    set.insert("name".into(), Value::String("host".into()));
    set.insert("dir".into(), path(&v.set_dir));
    set.insert("work_root".into(), path(&v.work_root));
    set.insert("secrets_dir".into(), path(&v.secrets_dir));
    set.entry("project")
        .or_insert_with(|| Value::String(PROJECT.into()));
    set.insert("driver".into(), Value::String("compose".into()));
    set.insert("socket_cli".into(), path(&v.socket));
    set.insert("socket_mount".into(), path(&v.socket_mount));
    set.insert(
        "engine".into(),
        Value::String(if v.rootful { "rootful" } else { "rootless" }.into()),
    );
    let env = table(&mut t, "envelope");
    env.insert("task_subnets".into(), Value::String(v.task_subnets.clone()));
    env.insert("allow_socket".into(), Value::Boolean(true));
    env.insert("rootful_ack".into(), Value::Boolean(v.rootful));
    env.insert("userns_remap".into(), Value::Boolean(v.userns_remap));
    env.insert("dedicated".into(), Value::Boolean(v.dedicated));
    env.entry("drivers")
        .or_insert_with(|| Value::Array(vec![Value::String("compose".into())]));
    for (k, cap) in [
        ("max_units", v.max_units),
        ("max_cpus", v.max_cpus),
        ("max_mem_gb", v.max_mem_gb),
    ] {
        if let Some(c) = cap {
            env.insert(k.into(), Value::Integer(i64::from(c)));
        }
    }
    match &v.vm {
        Some(vm) => {
            let table = table(&mut t, "vm");
            table.insert("runtime".into(), Value::String(vm.runtime.into()));
            if vm.runtime == "colima" {
                table.insert("profile".into(), Value::String(crate::vm::PROFILE.into()));
                table.insert("rosetta".into(), Value::Boolean(vm.rosetta));
                table.insert("disk_gb".into(), Value::Integer(i64::from(vm.disk_gb)));
            } else {
                for k in ["profile", "rosetta", "disk_gb"] {
                    table.remove(k);
                }
            }
        }
        None => {
            t.remove("vm");
        }
    }
    let body = toml::to_string(&t).map_err(|e| format!("agent.toml: {e}"))?;
    Ok(format!(
        "# The agent's envelope (design v2 §12): written by `omarchy-agent install` and by a\n# person at this host, never by the pool. Narrow it here; widening is yours alone.\n{body}"
    ))
}

/// An existing agent.toml's `[set].<key>`.
pub(crate) fn set_str(existing: Option<&str>, key: &str) -> Option<String> {
    let t: Table = toml::from_str(existing?).ok()?;
    t.get("set")?.get(key)?.as_str().map(str::to_owned)
}

/// An existing agent.toml's `[set].<key>`, as a path.
pub(crate) fn set_path(existing: Option<&str>, key: &str) -> Option<PathBuf> {
    set_str(existing, key).map(PathBuf::from)
}

/// An existing agent.toml's `[<table>].<key>`, as text.
pub(crate) fn table_str(existing: Option<&str>, table: &str, key: &str) -> Option<String> {
    let t: Table = toml::from_str(existing?).ok()?;
    t.get(table)?.get(key)?.as_str().map(str::to_owned)
}

/// An existing agent.toml's `[envelope].<key>`.
pub(crate) fn envelope_value(existing: Option<&str>, key: &str) -> Option<Value> {
    let t: Table = toml::from_str(existing?).ok()?;
    t.get("envelope")?.get(key).cloned()
}
