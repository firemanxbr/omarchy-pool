//! Orders from the pool (#277): a worker follows the brain for its health.
//!
//! The pool gives an order only in the answer to this worker's own claim —
//! there is no connection into its host — and only when the claim declared
//! the kinds this process takes (`orders`). The answer that carries orders
//! carries no task. This module is the worker's side that needs no network:
//! reading a claim answer that may be anything (a pool bug must never end
//! the process), the order's shape, what this process declares — found from
//! its own container when it can verify which one it is —, the brake on
//! claims that keep bringing orders, the ids already executed, the line a
//! reason is printed as, and the note a deliberate exit leaves for the next
//! process. `work.rs` claims, obeys and answers with them.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// A kind of order this worker knows. Anything else is kept by name, so it
/// can be refused by name (`unknown-kind`): an older worker ignores a newer
/// kind, and says so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderKind {
    RecheckAgent,
    Restart,
    RestartAgent,
    Drain,
    Unknown(String),
}

impl OrderKind {
    fn of(s: &str) -> Self {
        match s {
            "recheck-agent" => Self::RecheckAgent,
            "restart" => Self::Restart,
            "restart-agent" => Self::RestartAgent,
            "drain" => Self::Drain,
            other => Self::Unknown(other.chars().take(40).collect()),
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::RecheckAgent => "recheck-agent",
            Self::Restart => "restart",
            Self::RestartAgent => "restart-agent",
            Self::Drain => "drain",
            Self::Unknown(s) => s,
        }
    }
}

/// An order as the claim answer carries it. Its fields may only make the
/// worker do less than its kind says (`unless_agent_ok`): it names no image,
/// command, path or service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    pub id: String,
    pub kind: OrderKind,
    pub reason: String,
    pub issued_by: String,
    pub unless_agent_ok: bool,
    pub notice: bool,
}

/// What a claim answer says, read without ever failing.
#[derive(Debug)]
pub enum ClaimAnswer<T> {
    /// A task to run, with its job token.
    Task(T, String),
    /// Orders for this process, and no task.
    Orders(Vec<Order>),
    /// A task whose id and token can be read and whose rest cannot: the
    /// worker reports it failed, so its lease is not held for half an hour.
    BadTask { id: u64, token: String, why: String },
    /// Nothing this worker understands: logged, and slept on.
    Unreadable(String),
}

/// The first 200 characters of what came, for the log line.
fn head(v: &Value) -> String {
    v.to_string().chars().take(200).collect()
}

/// An order's id is `wo_` and 32 hex digits: the worker puts it in a path.
pub fn order_id_ok(id: &str) -> bool {
    id.len() == 35
        && id.starts_with("wo_")
        && id[3..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn read_order(v: &Value) -> Option<Order> {
    let id = v.get("id")?.as_str()?;
    if !order_id_ok(id) {
        return None;
    }
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default();
    Some(Order {
        id: id.to_owned(),
        kind: OrderKind::of(v.get("kind").and_then(Value::as_str).unwrap_or("?")),
        reason: clean_line(text("reason")),
        issued_by: clean_line(text("issued_by")),
        unless_agent_ok: v
            .get("unless_agent_ok")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        notice: v.get("notice").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// The orders an answer carries — a claim's, or a 426's — each read on its
/// own: one it cannot read is left out, the others stand.
pub fn orders_in(v: &Value) -> Result<Vec<Order>, String> {
    match v.get("orders") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(list)) => Ok(list.iter().filter_map(read_order).collect()),
        Some(other) => Err(format!("orders is not a list: {}", head(other))),
    }
}

/// Reads a claim answer (§1.8.1 of #277's design): a task, orders, a task
/// that cannot be read but can be failed, or nothing understood — never an
/// error that ends the worker. Unknown fields are ignored, a future one too.
pub fn read_claim<T: DeserializeOwned>(v: &Value) -> ClaimAnswer<T> {
    if !v.is_object() {
        return ClaimAnswer::Unreadable(head(v));
    }
    let orders = match orders_in(v) {
        Ok(o) => o,
        Err(why) => return ClaimAnswer::Unreadable(why),
    };
    match v.get("task") {
        None | Some(Value::Null) => {
            if orders.is_empty() {
                ClaimAnswer::Unreadable(head(v))
            } else {
                ClaimAnswer::Orders(orders)
            }
        }
        Some(task) => {
            let id = task.get("id").and_then(Value::as_u64);
            let token = v.get("token").and_then(Value::as_str);
            match (id, token) {
                (Some(id), Some(token)) => match serde_json::from_value::<T>(task.clone()) {
                    Ok(t) => ClaimAnswer::Task(t, token.to_owned()),
                    Err(e) => ClaimAnswer::BadTask {
                        id,
                        token: token.to_owned(),
                        why: e.to_string(),
                    },
                },
                _ => ClaimAnswer::Unreadable(head(v)),
            }
        }
    }
}

/// A line a person or the pool wrote, as this worker prints it: escape
/// sequences, control characters and the bidi overrides out, one line, 300
/// characters at most. A reason reaches terminals through `docker logs`.
pub fn clean_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(300));
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ … final byte in @..~; OSC: ESC ] … BEL or ESC \.
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for d in chars.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(d) = chars.next() {
                        if d == '\u{7}' || (d == '\u{1b}' && chars.peek() == Some(&'\\')) {
                            if d == '\u{1b}' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if c == '\n' || c == '\r' || c == '\t' {
            out.push(' ');
        } else if !c.is_control()
            && !('\u{202a}'..='\u{202e}').contains(&c)
            && !('\u{2066}'..='\u{2069}').contains(&c)
        {
            out.push(c);
        }
    }
    let line: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    line.chars().take(300).collect()
}

/// The brake on a pool that keeps sending orders: at least 2 s between two
/// claims that bring orders, and after three in a row, the idle poll. A
/// claim that brings a task or nothing starts it again.
#[derive(Debug, Default)]
pub struct Brake {
    streak: u32,
}

impl Brake {
    pub const MIN_GAP: Duration = Duration::from_secs(2);
    pub const IN_A_ROW: u32 = 3;

    /// How long to wait before the next claim, after one that did (or did not) bring orders; `poll` is the idle poll.
    pub fn after(&mut self, orders: bool, poll: Duration) -> Duration {
        if !orders {
            self.streak = 0;
            return Duration::ZERO;
        }
        self.streak += 1;
        if self.streak >= Self::IN_A_ROW {
            poll
        } else {
            Self::MIN_GAP
        }
    }

    pub fn slowed(&self) -> bool {
        self.streak >= Self::IN_A_ROW
    }
}

/// The ids this process executed, the last 64: an id is never executed twice.
#[derive(Debug, Default)]
pub struct Seen(VecDeque<String>);

impl Seen {
    /// True the first time an id is seen.
    pub fn first(&mut self, id: &str) -> bool {
        if self.0.iter().any(|x| x == id) {
            return false;
        }
        if self.0.len() >= 64 {
            self.0.pop_front();
        }
        self.0.push_back(id.to_owned());
        true
    }
}

/// This process, for the pool: 32 hex digits drawn once at start.
pub fn new_instance() -> String {
    let mut bytes = [0u8; 16];
    let random = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes));
    if random.is_err() {
        // No /dev/urandom: the time and the pid, hashed — unique enough to tell two processes apart.
        let seed = format!("{:?}{}", std::time::SystemTime::now(), std::process::id());
        bytes.copy_from_slice(&Sha256::digest(seed.as_bytes())[..16]);
    }
    hex::encode(bytes)
}

// ---------- what this process is, from its own container ----------

/// The ids that may be this container's, in the order they are tried: the
/// source of the `/etc/hostname` bind mount (docker's
/// `…/containers/<id>/hostname`, podman's `…/overlay-containers/<id>/userdata/hostname`,
/// whatever `hostname:` compose set), podman's `/run/.containerenv`, then
/// the hostname itself as a short id.
pub fn container_candidates(
    mountinfo: &str,
    containerenv: Option<&str>,
    hostname: Option<&str>,
) -> Vec<String> {
    let mut out = Vec::new();
    for line in mountinfo.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() > 4 && f[4] == "/etc/hostname" {
            if let Some(id) = hex64_after(f[3], "containers/") {
                out.push(id);
            }
        }
    }
    if let Some(env) = containerenv {
        for l in env.lines() {
            if let Some(v) = l.strip_prefix("id=") {
                let v = v.trim_matches('"');
                if is_hex(v) && !v.is_empty() {
                    out.push(v.to_owned());
                }
            }
        }
    }
    if let Some(h) = hostname.map(str::trim) {
        if h.len() >= 12 && is_hex(h) {
            out.push(h.to_owned());
        }
    }
    let mut seen = Vec::new();
    out.retain(|x| {
        let new = !seen.contains(x);
        seen.push(x.clone());
        new
    });
    out
}

fn is_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex64_after(path: &str, marker: &str) -> Option<String> {
    // The last one: podman's path has "containers/" twice (…/containers/storage/overlay-containers/<id>/…).
    let at = path.rfind(marker)? + marker.len();
    let id = path.get(at..at + 64)?;
    (is_hex(id) && path.as_bytes().get(at + 64) == Some(&b'/')).then(|| id.to_owned())
}

/// What `docker inspect <id>` says of this container that matters here.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inspect {
    pub policy: String,
    pub max_retries: i64,
    pub restart_count: i64,
    pub project: Option<String>,
    pub working_dir: Option<String>,
}

/// Reads `docker inspect` (or podman's, the same shape): an array of one.
pub fn parse_inspect(v: &Value) -> Option<Inspect> {
    let c = v.as_array().and_then(|a| a.first()).unwrap_or(v);
    let host = c.get("HostConfig")?;
    let policy = host
        .pointer("/RestartPolicy/Name")
        .and_then(Value::as_str)
        .unwrap_or("no")
        .to_owned();
    let labels = c.pointer("/Config/Labels");
    let label = |k: &str| {
        labels
            .and_then(|l| l.get(k))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Some(Inspect {
        policy: if policy.is_empty() {
            "no".to_owned()
        } else {
            policy
        },
        max_retries: host
            .pointer("/RestartPolicy/MaximumRetryCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        restart_count: c.get("RestartCount").and_then(Value::as_i64).unwrap_or(0),
        project: label("com.docker.compose.project"),
        working_dir: label("com.docker.compose.project.working_dir"),
    })
}

/// Whether this process may take `restart`, and how many restarts its
/// policy has left (only under `on-failure:N`): the engine starts it again
/// only under `always`, `unless-stopped` or `on-failure` with retries to
/// spare — each exit spends one of N for the container's whole life, so it
/// declares restart only with three or more left. A bare binary declares it
/// only when a supervisor says it restarts it (`OMARCHY_SUPERVISED=1`).
pub fn declares_restart(inspect: Option<&Inspect>, supervised: bool) -> (bool, Option<i64>) {
    match inspect {
        None => (supervised, None),
        Some(i) => match i.policy.as_str() {
            "always" | "unless-stopped" => (true, None),
            "on-failure" if i.max_retries == 0 => (true, None),
            "on-failure" => {
                let left = (i.max_retries - i.restart_count).max(0);
                (left >= 3, Some(left))
            }
            _ => (false, None),
        },
    }
}

/// The site: which workers share one compose project on one engine, without
/// saying which — the first 16 hex digits of sha256(engine id, "\n",
/// project). Only from an engine id two reads agree on: podman's
/// Docker-compatible answer gives none, or a new one each time, and a site
/// made of it would merge every podman set with the default project name.
pub fn site_of(engine_a: &str, engine_b: &str, project: &str) -> Option<String> {
    let (a, b) = (engine_a.trim(), engine_b.trim());
    if a.is_empty() || a != b || project.is_empty() {
        return None;
    }
    let h = Sha256::digest(format!("{a}\n{project}").as_bytes());
    Some(hex::encode(&h[..8]))
}

/// The host a base URL names (`http://agent-proxy:8790` is `agent-proxy`).
pub fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let hostport = rest.split(['/', '?', '#']).next()?;
    let host = hostport.rsplit_once('@').map_or(hostport, |(_, h)| h);
    let host = host.split(':').next()?.trim();
    (!host.is_empty()).then(|| host.to_owned())
}

// ---------- the note a deliberate exit leaves ----------

/// Whether this process runs in a container: docker's `/.dockerenv`, podman's `/run/.containerenv`.
pub fn in_container() -> bool {
    Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists()
}

/// Where a process leaves its `previous_exit` note: in a container, its
/// own writable layer (`/var/lib/omarchy`), which a restart by the restart
/// policy keeps and a recreated container does not; a bare binary keeps it
/// beside its work directory — two bare workers on one host never share
/// a note, whoever may write `/var/lib/omarchy`.
pub fn state_dir(work_dir: &Path) -> PathBuf {
    state_dir_for(work_dir, in_container(), Path::new("/var/lib/omarchy"))
}

pub fn state_dir_for(work_dir: &Path, container: bool, layer: &Path) -> PathBuf {
    if container && std::fs::create_dir_all(layer).is_ok() && is_writable(layer) {
        return layer.to_path_buf();
    }
    work_dir.join(".omarchy-state")
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".w");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(probe);
    ok
}

/// Writes the note before a deliberate exit: why (idle, drain, restart).
pub fn leave_exit_note(dir: &Path, why: &str, at: &str) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(
        dir.join("last-exit"),
        serde_json::json!({ "why": why, "at": at }).to_string(),
    );
}

/// Reads the previous process's note: said with this process's claims until
/// the pool has heard one (`clear_exit_note`), so a first claim lost on the
/// network does not lose why the process before ended. A note of an
/// unknown kind is none.
pub fn read_exit_note(dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(dir.join("last-exit")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    matches!(
        v.get("why").and_then(Value::as_str),
        Some("idle" | "drain" | "restart" | "watchdog")
    )
    .then_some(v)
}

/// The pool has heard the note: it goes.
pub fn clear_exit_note(dir: &Path) {
    let _ = std::fs::remove_file(dir.join("last-exit"));
}

/// `AGENT_RETRY_FIRST_SECONDS`: the first re-check after a failed probe, 15 s
/// unless told, never under 15 s or past the half-hour probe — it can only
/// make the backoff slower, so it never spends more completions.
pub fn agent_retry_first(v: Option<&str>) -> Duration {
    let secs = v.and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(15);
    Duration::from_secs(secs.clamp(15, 1800))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize, Debug)]
    struct T {
        id: u64,
        #[allow(dead_code)]
        kind: String,
    }

    fn order(id: &str, kind: &str) -> Value {
        serde_json::json!({ "id": id, "kind": kind, "reason": "why", "issued_by": "pool", "unless_agent_ok": true, "notice": false })
    }
    const ID: &str = "wo_0123456789abcdef0123456789abcdef";

    #[test]
    fn a_claim_answer_never_ends_the_worker() {
        // Orders, no task.
        let a = read_claim::<T>(
            &serde_json::json!({ "task": null, "orders": [order(ID, "restart"), order(ID, "reboot-the-host"), { "id": "../../x", "kind": "restart" }] }),
        );
        let ClaimAnswer::Orders(o) = a else {
            panic!("orders: {a:?}")
        };
        assert_eq!(
            o.len(),
            2,
            "an order with an id it cannot put in a path is left out"
        );
        assert_eq!(o[0].kind, OrderKind::Restart);
        assert!(o[0].unless_agent_ok);
        assert_eq!(o[1].kind, OrderKind::Unknown("reboot-the-host".to_owned()));
        // A task, as today, with a field from the future.
        let a = read_claim::<T>(
            &serde_json::json!({ "task": { "id": 812, "kind": "build" }, "token": "omj.x", "later": 1 }),
        );
        assert!(matches!(a, ClaimAnswer::Task(T { id: 812, .. }, ref t) if t == "omj.x"));
        // A task with an id and a token but a shape it cannot read: failed, not held.
        let a = read_claim::<T>(
            &serde_json::json!({ "task": { "id": 813, "kind": 7 }, "token": "omj.y" }),
        );
        assert!(matches!(a, ClaimAnswer::BadTask { id: 813, .. }), "{a:?}");
        // Everything else: understood as nothing, and said.
        for bad in [
            serde_json::json!("not an object"),
            serde_json::json!({ "orders": "x" }),
            serde_json::json!({ "task": 42 }),
            serde_json::json!({ "task": {} }),
            serde_json::json!({}),
            serde_json::json!([1, 2]),
        ] {
            assert!(
                matches!(read_claim::<T>(&bad), ClaimAnswer::Unreadable(_)),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_reason_is_printed_as_one_clean_line() {
        assert_eq!(
            clean_line("stuck \u{1b}[31mred\u{1b}[0m\r\nsince\u{202e} v1.0.1\u{7} $(touch /tmp/x)"),
            "stuck red since v1.0.1 $(touch /tmp/x)"
        );
        assert_eq!(clean_line("\u{1b}]0;title\u{7}ok"), "ok");
        assert_eq!(clean_line(&"x".repeat(400)).len(), 300);
    }

    #[test]
    fn the_brake_slows_a_pool_that_keeps_sending_orders() {
        let poll = Duration::from_secs(30);
        let mut b = Brake::default();
        let gaps: Vec<u64> = [true, true, true, true, false, true]
            .iter()
            .map(|&o| b.after(o, poll).as_secs())
            .collect();
        assert_eq!(gaps, [2, 2, 30, 30, 0, 2]);
    }

    #[test]
    fn an_order_is_executed_once() {
        let mut s = Seen::default();
        assert!(s.first(ID));
        assert!(!s.first(ID));
        for i in 0..70 {
            s.first(&format!("wo_{i:032x}"));
        }
        assert!(s.first(ID), "the last 64 only");
    }

    #[test]
    fn this_container_is_found_from_its_hostname_mount() {
        let docker = format!("1085 1060 0:32 /var/lib/docker/containers/{}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw", "a".repeat(64));
        assert_eq!(container_candidates(&docker, None, None), ["a".repeat(64)]);
        let podman = format!("844 823 0:48 /containers/storage/overlay-containers/{}/userdata/hostname /etc/hostname rw - tmpfs tmpfs rw", "b".repeat(64));
        assert_eq!(
            container_candidates(
                &podman,
                Some("engine=\"podman\"\nid=\"cafe\""),
                Some("review-aarch64")
            ),
            ["b".repeat(64), "cafe".to_owned()]
        );
        // A hostname compose set (not an id), under network_mode: host: the mount still names the container.
        assert_eq!(
            container_candidates(&docker, None, Some("studio")),
            ["a".repeat(64)]
        );
        assert_eq!(
            container_candidates("", None, Some("0123456789ab")),
            ["0123456789ab"]
        );
        assert!(container_candidates("", None, Some("my-laptop")).is_empty());
    }

    #[test]
    fn restart_is_declared_only_where_the_engine_starts_it_again() {
        let i = |policy: &str, max: i64, count: i64| Inspect {
            policy: policy.to_owned(),
            max_retries: max,
            restart_count: count,
            ..Inspect::default()
        };
        assert_eq!(
            declares_restart(Some(&i("unless-stopped", 0, 9)), false),
            (true, None)
        );
        assert_eq!(
            declares_restart(Some(&i("always", 0, 0)), false),
            (true, None)
        );
        assert_eq!(
            declares_restart(Some(&i("on-failure", 0, 7)), false),
            (true, None)
        );
        assert_eq!(
            declares_restart(Some(&i("on-failure", 5, 1)), false),
            (true, Some(4))
        );
        assert_eq!(
            declares_restart(Some(&i("on-failure", 5, 3)), false),
            (false, Some(2))
        );
        assert_eq!(declares_restart(Some(&i("no", 0, 0)), true), (false, None));
        assert_eq!(declares_restart(None, false), (false, None));
        assert_eq!(declares_restart(None, true), (true, None));
        let v = serde_json::json!([{ "RestartCount": 2, "HostConfig": { "RestartPolicy": { "Name": "on-failure", "MaximumRetryCount": 6 } }, "Config": { "Labels": { "com.docker.compose.project": "omarchy-pool", "com.docker.compose.project.working_dir": "/srv/omarchy-pool" } } }]);
        assert_eq!(
            parse_inspect(&v),
            Some(Inspect {
                policy: "on-failure".to_owned(),
                max_retries: 6,
                restart_count: 2,
                project: Some("omarchy-pool".to_owned()),
                working_dir: Some("/srv/omarchy-pool".to_owned())
            })
        );
    }

    #[test]
    fn a_site_is_made_only_of_an_engine_id_two_reads_agree_on() {
        let site = site_of("ABCD:EFGH", "ABCD:EFGH", "omarchy-pool").unwrap();
        assert_eq!(site.len(), 16);
        assert_eq!(
            Some(site),
            site_of(" ABCD:EFGH\n", "ABCD:EFGH", "omarchy-pool")
        );
        assert_eq!(
            site_of("", "", "omarchy-worker"),
            None,
            "podman's empty answer"
        );
        assert_eq!(
            site_of("one", "two", "omarchy-worker"),
            None,
            "a value made for each answer"
        );
        assert_ne!(site_of("A", "A", "p1"), site_of("A", "A", "p2"));
        assert_eq!(
            url_host("http://agent-proxy:8790"),
            Some("agent-proxy".to_owned())
        );
        assert_eq!(
            url_host("https://user@api.anthropic.com/v1"),
            Some("api.anthropic.com".to_owned())
        );
        assert_eq!(url_host(""), None);
    }

    #[test]
    fn a_deliberate_exit_leaves_a_note_the_next_process_reads_until_the_pool_has_heard_it() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_exit_note(dir.path()).is_none());
        leave_exit_note(dir.path(), "restart", "2026-09-29T13:36:02Z");
        let v = read_exit_note(dir.path()).unwrap();
        assert_eq!(v["why"], "restart");
        // A claim that did not reach the pool keeps it: the next claim says it again.
        assert_eq!(read_exit_note(dir.path()).unwrap()["why"], "restart");
        clear_exit_note(dir.path());
        assert!(read_exit_note(dir.path()).is_none(), "once heard, gone");
        std::fs::write(dir.path().join("last-exit"), "{\"why\":\"crash\"}").unwrap();
        assert!(
            read_exit_note(dir.path()).is_none(),
            "a reason it does not know is not sent"
        );
    }

    #[test]
    fn a_bare_binary_keeps_its_note_beside_its_work_directory_even_where_it_could_write_a_containers(
    ) {
        let work = tempfile::tempdir().unwrap();
        let layer = tempfile::tempdir().unwrap();
        // Outside a container: beside the work directory, though the container's path is writable — two bare workers on one
        // host never take each other's note.
        assert_eq!(
            state_dir_for(work.path(), false, layer.path()),
            work.path().join(".omarchy-state")
        );
        // In a container: its own writable layer, which a restart by the restart policy keeps.
        assert_eq!(state_dir_for(work.path(), true, layer.path()), layer.path());
        // In a container whose layer it cannot write: beside the work directory again.
        let file = layer.path().join("not-a-dir");
        std::fs::write(&file, b"").unwrap();
        assert_eq!(
            state_dir_for(work.path(), true, &file.join("x")),
            work.path().join(".omarchy-state")
        );
    }

    #[test]
    fn the_first_recheck_can_only_be_made_slower() {
        let s = |v: Option<&str>| agent_retry_first(v).as_secs();
        assert_eq!(
            [
                s(None),
                s(Some("3")),
                s(Some("1800")),
                s(Some("9999")),
                s(Some("x")),
                s(Some("60"))
            ],
            [15, 15, 1800, 1800, 15, 60]
        );
    }

    #[test]
    fn an_instance_is_32_hex_digits_and_new_each_time() {
        let (a, b) = (new_instance(), new_instance());
        assert_eq!(a.len(), 32);
        assert!(is_hex(&a));
        assert_ne!(a, b);
        assert!(order_id_ok(ID));
        assert!(!order_id_ok("wo_XYZ"));
    }
}
