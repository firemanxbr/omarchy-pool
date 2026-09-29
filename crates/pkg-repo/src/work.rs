//! `pkg-repo work`: a worker of the pool. It asks the pool for work with its
//! own registered token, receives a task and a credential good for that task
//! only, does the work — sync, render, promote (with evidence, gate, health
//! and rollback), health, gc — and reports. Nothing here needs GitHub: the
//! Cloudflare cron creates the jobs, any machine the project trusts pulls
//! them.
//!
//! The health and ABI checks are the same scripts the pipeline runs
//! (`tests/health-check.sh`, `tests/abi-gate.sh`), taken from a checkout of
//! the repository at this binary's version; they need podman (or docker),
//! python3 and curl on the host.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::client::{Api, ReleaseRequest};
use crate::gate::{self, GateOptions, Verdict};
use crate::ops;
use crate::orders::{self, ClaimAnswer, Order, OrderKind};
use crate::RepoError;

/// The worker's own log — the lines between tasks — as the claim carries it
/// to the pool: the owner and the maintainers read it on the dashboard. A
/// few kilobytes since the last claim; what a build printed goes to its
/// log and staging, never here.
static WORKER_LOG: Mutex<String> = Mutex::new(String::new());
fn say(line: impl AsRef<str>) {
    let line = line.as_ref();
    eprintln!("{line}");
    let stamp = chrono_stamp();
    if let Ok(mut log) = WORKER_LOG.lock() {
        log.push_str(&stamp);
        log.push(' ');
        log.push_str(line);
        log.push('\n');
        if log.len() > 4096 {
            let cut = log.len() - 4096;
            let at = log
                .char_indices()
                .map(|(i, _)| i)
                .find(|&i| i >= cut)
                .unwrap_or(cut);
            log.drain(..at);
        }
    }
}
/// What the claim takes with it, and the buffer forgets.
fn log_chunk() -> String {
    WORKER_LOG
        .lock()
        .map(|mut l| std::mem::take(&mut *l))
        .unwrap_or_default()
}
/// `[HH:MM:SS]`, the bash worker's stamp, from the wall clock without a date crate.
fn chrono_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
        % 86_400;
    format!(
        "[{:02}:{:02}:{:02}]",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}
use crate::security::{self, FastTrackOptions, SecurityOptions};
use crate::sync::SyncOptions;

pub const REPO_URL: &str = "https://github.com/firemanxbr/omarchy-pool";
const HEARTBEAT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_secs(30);

/// The agent providers `factory/bin/agent.py` knows, in the order it picks
/// them when several keys are set: (name, key variable, default model).
const AGENTS: [(&str, &str, &str); 5] = [
    ("anthropic", "ANTHROPIC_API_KEY", "claude-sonnet-5"),
    ("claude-code", "CLAUDE_CODE_OAUTH_TOKEN", "claude-sonnet-5"),
    ("openai", "OPENAI_API_KEY", "gpt-5"),
    ("gemini", "GEMINI_API_KEY", "gemini-3.6-flash"),
    ("xai", "XAI_API_KEY", "grok-4"),
];

/// A `FACTORY_MODEL` that plainly belongs to another provider is ignored for
/// the default, as agent.py does (a switch of provider with the old model
/// left in the file): the label says what will actually run.
fn model_fits(provider: &str, model: &str) -> bool {
    let family = match provider {
        "anthropic" | "claude-code" => "claude",
        "gemini" => "gemini",
        "xai" => "grok",
        _ => return true,
    };
    model.to_ascii_lowercase().starts_with(family)
}

/// The agent this worker runs, as `<provider>/<model>` — what the claim
/// reports so the Workers page can show it; the key itself stays here.
/// None without a key. `FACTORY_PROVIDER` and `FACTORY_MODEL` override the
/// choice the way `agent.py` honours them.
pub fn agent_label() -> Option<String> {
    let set = |var: &str| std::env::var(var).is_ok_and(|k| !k.is_empty());
    let wanted = std::env::var("FACTORY_PROVIDER")
        .ok()
        .filter(|p| !p.is_empty());
    let (name, _, default_model) = AGENTS
        .iter()
        .find(|(name, key, _)| wanted.as_deref().is_none_or(|w| w == *name) && set(key))?;
    let model = std::env::var("FACTORY_MODEL")
        .ok()
        .filter(|m| !m.is_empty() && model_fits(name, m))
        .unwrap_or_else(|| (*default_model).to_owned());
    Some(format!("{name}/{model}"))
}

/// What a worker pulls when `--kind` is not given: every pool job and the
/// project builds, plus `audit` when this machine has an agent key — the
/// second agent (docs/GOVERNANCE.md) runs only where its owner put one.
pub fn default_kinds() -> Vec<String> {
    let mut kinds: Vec<String> = [
        "build", "sync", "render", "promote", "health", "security", "enqueue", "rollback", "gc",
        "verify", "relayout", "publish", "trial",
    ]
    .iter()
    .map(|k| (*k).to_owned())
    .collect();
    if agent_label().is_some() {
        kinds.push("audit".to_owned());
    }
    kinds
}

pub struct WorkOptions {
    pub api: String,
    pub pool: String,
    /// The worker's own token (`omw_…`); the registration names the worker.
    pub worker_token: String,
    pub arch: String,
    pub kinds: Vec<String>,
    /// A community worker that builds anyone's packages, not only its owner's.
    pub shared: bool,
    pub labels: serde_json::Value,
    pub once: bool,
    /// Exit after this many seconds without work (0 = never).
    pub idle_exit: u64,
    pub work_dir: PathBuf,
    /// Local key id that signs packages and databases against a pool
    /// without its own signing key (transition; ignored when the pool signs).
    pub sign: Option<String>,
    /// A checkout of the repository (its tests/ scripts); cloned when absent.
    pub repo_dir: Option<PathBuf>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Task {
    pub id: u64,
    pub kind: String,
    pub name: String,
    pub arch: String,
    pub trust: String,
    #[serde(default)]
    pub pkgbuild_ref: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub max_attempts: u32,
}

/// What a job reports back: a one-line summary and a JSON result.
pub struct Outcome {
    pub summary: String,
    pub result: serde_json::Value,
}

/// The agent's answer to the probe, as the claim reports it.
#[derive(Debug, Clone, Default)]
struct AgentProbe {
    status: String,
    error: String,
    /// Who really answered, as the probe says (`agent`): behind a broker the
    /// environment names `anthropic/…` while Claude Code answers.
    label: String,
    checked_at: Option<std::time::Instant>,
    checked_iso: String,
    /// How long the answer took, for the log.
    ms: u64,
}

/// Does the agent answer? `factory/bin/agent.py --probe` in the pool's
/// checkout: one tiny completion. A key set is not an agent that works — a
/// worker whose agent does not answer is not ready for an audit or a build
/// (docs/GOVERNANCE.md, *Workers*); the brain reads this with every claim.
///
/// Stamped when the answer came, not when the question went: a probe can
/// take its whole two minutes (`agent.py` waits 30, 60, 120 s on a 429 or
/// a 5xx, and agent-proxy answers 502 until Claude Code is installed), and
/// the next one is due that long after the last answer — measured from the
/// start, a slow failing agent kept the claim loop inside the probe most of
/// the time (found in review, #273).
fn probe_agent(opts: &WorkOptions) -> AgentProbe {
    let mut p = ask_agent(opts);
    p.checked_at = Some(Instant::now());
    p.checked_iso = chrono_now();
    p
}

fn ask_agent(opts: &WorkOptions) -> AgentProbe {
    let mut p = AgentProbe::default();
    let script = match repo_dir(opts) {
        Ok(dir) => dir.join("factory/bin/agent.py"),
        Err(e) => {
            "error".clone_into(&mut p.status);
            p.error = format!("no checkout to probe from: {e:#}");
            return p;
        }
    };
    let out = Command::new("timeout")
        .args(["120", "python3"])
        .arg(&script)
        .arg("--probe")
        .output();
    match out {
        Ok(o) if o.status.success() => {
            "ok".clone_into(&mut p.status);
            let v = serde_json::from_slice::<serde_json::Value>(&o.stdout).ok();
            let ms = v
                .as_ref()
                .and_then(|v| v.get("ms").and_then(serde_json::Value::as_u64))
                .unwrap_or(0);
            v.as_ref()
                .and_then(|v| v.get("agent").and_then(|a| a.as_str()))
                .unwrap_or_default()
                .clone_into(&mut p.label);
            p.ms = ms;
        }
        Ok(o) => {
            "error".clone_into(&mut p.status);
            p.error = serde_json::from_slice::<serde_json::Value>(&o.stdout)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str().map(str::to_owned)))
                .unwrap_or_else(|| {
                    String::from_utf8_lossy(&o.stderr)
                        .trim()
                        .chars()
                        .take(300)
                        .collect()
                });
            if p.error.is_empty() {
                "no answer".clone_into(&mut p.error);
            }
        }
        Err(e) => {
            "error".clone_into(&mut p.status);
            p.error = format!("probe did not run: {e}");
        }
    }
    p
}

/// A probe that did not answer is not a verdict for half an hour: the
/// agent behind it may only be starting — the agent proxy replaced in the
/// same rollout refused both review workers on the Studio at their only
/// check, and they stayed not ready for 35 minutes after v1.0.0 and again
/// after v1.0.1, until someone restarted them (#273). A failed probe is
/// tried again after 15 s, doubled at each failure, until the agent
/// answers — and the doubling stops at `AGENT_PROBE_EVERY`, the half hour
/// an agent that answers is probed at: an agent that is starting answers
/// within the first few re-checks, and one that fails for good (no credit,
/// a revoked key) is asked no more often than before, each probe a real
/// completion (found in review). Every result goes with the next claim.
const AGENT_RETRY_FIRST: Duration = Duration::from_secs(15);

/// How long after the `failures`-th failed probe in a row the next one runs: 15 s, 30 s, 60 s … 16 min, then every half hour.
#[cfg(test)]
fn agent_retry_after(failures: u32) -> Duration {
    agent_retry_from(AGENT_RETRY_FIRST, failures)
}

/// The same schedule from another first delay (`AGENT_RETRY_FIRST_SECONDS`,
/// #277: 15 s unless told, never under it — the E2E waits half an hour, so
/// the pool alone brings a worker back): doubled at each failure, never past
/// the healthy agent's half hour.
fn agent_retry_from(first: Duration, failures: u32) -> Duration {
    let doubled = first.saturating_mul(1u32 << failures.saturating_sub(1).min(16));
    doubled.min(AGENT_PROBE_EVERY)
}

/// The agent's standing between probes: the last answer (what the claims
/// report), how many probes in a row did not answer, and when to ask again.
#[derive(Debug, Default)]
struct AgentCheck {
    probe: AgentProbe,
    failures: u32,
    /// The first re-check after a failure; 15 s when unset.
    first: Option<Duration>,
}

impl AgentCheck {
    fn due(&self, now: Instant) -> bool {
        let wait = if self.probe.status == "error" {
            agent_retry_from(self.first.unwrap_or(AGENT_RETRY_FIRST), self.failures)
        } else {
            AGENT_PROBE_EVERY
        };
        self.probe
            .checked_at
            .is_none_or(|t| now.saturating_duration_since(t) >= wait)
    }

    /// Takes a probe's answer; the line to log. A failure is said once per
    /// change of state — the first one, a different error, the answer
    /// again — never at every re-check; a healthy agent is said at each of
    /// its half-hour probes, as before.
    fn record(&mut self, p: AgentProbe) -> Option<String> {
        let who = if p.label.is_empty() {
            String::new()
        } else {
            format!(" {}", p.label)
        };
        let line = if p.status == "error" {
            self.failures += 1;
            let changed = self.probe.status != "error" || self.probe.error != p.error;
            changed.then(|| {
                format!(
                    "agent{who}: NOT ready — {}; checking again in {} s, then less often (up to every {} s) until it answers",
                    p.error,
                    agent_retry_from(self.first.unwrap_or(AGENT_RETRY_FIRST), self.failures).as_secs(),
                    AGENT_PROBE_EVERY.as_secs()
                )
            })
        } else if self.failures > 0 {
            let line = format!(
                "agent{who}: ok ({} ms) — answering again after {} failed check(s)",
                p.ms, self.failures
            );
            self.failures = 0;
            Some(line)
        } else {
            Some(format!("agent{who}: ok ({} ms)", p.ms))
        };
        self.probe = p;
        line
    }

    /// Takes the answer of a probe an order asked for (#277): stored and
    /// logged as `record` does, but a failure leaves the count alone, so the
    /// worker's own backoff keeps its schedule; an answer resets it.
    fn record_ordered(&mut self, p: AgentProbe) -> Option<String> {
        let failures = self.failures;
        let line = self.record(p);
        if self.probe.status == "error" {
            self.failures = failures;
        }
        line
    }

    /// The last probe, if it is younger than `max`: a re-check that one answered a moment ago spends no completion.
    fn fresh(&self, max: Duration) -> bool {
        self.probe.checked_at.is_some_and(|t| t.elapsed() < max)
    }
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    // ISO 8601 without a date crate: civil-from-days (Howard Hinnant).
    let days = i64::try_from(secs / 86400).unwrap_or(0);
    let (hour, minute, second) = ((secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

const AGENT_PROBE_EVERY: Duration = Duration::from_secs(30 * 60);

/// # Panics
/// When the heartbeat thread's mutex is poisoned, which needs a panic in that thread first.
#[allow(clippy::too_many_lines)] // the claim loop, read top to bottom: each way a claim can end is a few lines of its own
pub fn run(opts: &WorkOptions) -> Result<()> {
    std::fs::create_dir_all(&opts.work_dir)?;
    let claimer = Api::new(&opts.api, &opts.worker_token)?;
    let hostname = hostname();
    let version = pkg_manifest::BUILD_VERSION;
    let agent = agent_label();
    // What the machine uses, averaged on the worker's own clock; the claim reports it.
    let usage = crate::usage::Sampler::start(opts.work_dir.clone());
    // What this process is, for the pool (#277): which process, what it
    // takes, where its agent is — found from its own container when it can
    // verify which one it is — and why the one before it ended, once.
    let mut me = Process::start(opts, agent.is_some());
    eprintln!(
        "worker ({}) ready — {} — asking {} for {}{} — takes orders: {}",
        opts.arch,
        version,
        opts.api,
        opts.kinds.join(", "),
        agent
            .as_deref()
            .map(|a| format!(" — agent {a}"))
            .unwrap_or_default(),
        me.takes.join(", ")
    );
    // The keyrings the health check and the sync need, before the first job.
    if let Err(e) = keyrings(opts) {
        eprintln!("warning: keyrings not fetched yet ({e:#}); the first sync will retry");
    }
    // SIGTERM (what `docker stop` and a rolling upgrade send) drains: the
    // task in hand runs to its end and is reported, no new one is claimed,
    // then the process exits 0. Killing a worker mid-task only hands the
    // task to another worker thirty minutes later, when its lease expires.
    let draining = Arc::new(std::sync::atomic::AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(sig, draining.clone()).context("signal handler")?;
    }
    let is_draining = || draining.load(std::sync::atomic::Ordering::Relaxed);
    let mut idle = 0u64;
    let mut done = 0u32;
    let mut check = AgentCheck {
        first: Some(orders::agent_retry_first(
            std::env::var("AGENT_RETRY_FIRST_SECONDS").ok().as_deref(),
        )),
        ..AgentCheck::default()
    };
    let mut brake = orders::Brake::default();
    let mut seen = orders::Seen::default();
    loop {
        if is_draining() {
            say(format!(
                "draining: {done} task(s) done, none claimed since the stop signal; exiting"
            ));
            me.leave("drain");
            return Ok(());
        }
        if agent.is_some() && check.due(Instant::now()) {
            if let Some(line) = check.record(probe_agent(opts)) {
                say(line);
            }
            me.relay_sibling_log(&check);
        }
        me.reread();
        let probe = &check.probe;
        let mut body = serde_json::json!({
            "arch": opts.arch, "hostname": hostname, "version": version, "labels": opts.labels, "kinds": opts.kinds, "shared": opts.shared,
            "agent": if probe.label.is_empty() { agent.clone().unwrap_or_default() } else { probe.label.clone() },
            "agent_status": probe.status, "agent_error": probe.error, "agent_checked_at": probe.checked_iso,
            "usage": usage.report(),
            "log": log_chunk(),
        });
        me.say_in(&mut body);
        let answer = match claimer.post_json_as(&opts.worker_token, "/factory/claim", &body) {
            Ok(Some(v)) => orders::read_claim::<Task>(&v),
            Ok(None) => {
                brake.after(false, POLL);
                idle += POLL.as_secs();
                if opts.idle_exit > 0 && idle >= opts.idle_exit {
                    say(format!("no work for {idle}s; exiting"));
                    me.leave("idle");
                    return Ok(());
                }
                sleep_unless(POLL, &is_draining);
                continue;
            }
            // 426: this binary is behind the pool's release past the rollout's
            // grace — every worker follows the latest image, and the pool hands
            // this one nothing until the updater (or its owner) replaces it. An
            // order waiting for it rides the refusal: a re-check or a restart
            // needs no new image.
            Err(RepoError::Api { status: 426, body }) => {
                let v = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
                let why = v["error"].as_str().map_or(body.clone(), str::to_owned);
                say(format!("update required: {why}"));
                let list = orders::orders_in(&v).unwrap_or_default();
                if !list.is_empty() {
                    for o in &list {
                        obey(opts, &claimer, &mut me, &mut check, &mut seen, o);
                    }
                    sleep_unless(brake.after(true, POLL), &is_draining);
                    continue;
                }
                sleep_unless(Duration::from_secs(300), &is_draining);
                continue;
            }
            Err(e) => {
                say(format!("claim failed: {e}; retrying in 60 s"));
                sleep_unless(Duration::from_secs(60), &is_draining);
                continue;
            }
        };
        let (task, token) = match answer {
            ClaimAnswer::Task(task, token) => (task, token),
            ClaimAnswer::Orders(list) => {
                for o in &list {
                    obey(opts, &claimer, &mut me, &mut check, &mut seen, o);
                }
                let gap = brake.after(true, POLL);
                if brake.slowed() {
                    say("the pool keeps sending orders; slowing to 30 s");
                }
                sleep_unless(gap, &is_draining);
                continue;
            }
            // A task it cannot read, with a token it can: failed at once, so
            // its lease is not held for half an hour, and the next claim waits.
            ClaimAnswer::BadTask { id, token, why } => {
                say(format!(
                    "task {id}: this worker ({version}) could not read it: {why}; reported failed"
                ));
                if let Ok(job) = Api::new(&opts.api, &token) {
                    let _ = job.post_json_as(&token, &format!("/factory/tasks/{id}/fail"), &serde_json::json!({ "error": format!("worker {version} could not read this task: {why}"), "final": false }));
                }
                sleep_unless(POLL, &is_draining);
                continue;
            }
            ClaimAnswer::Unreadable(what) => {
                say(format!(
                    "claim answer not understood ({what}); waiting 30 s"
                ));
                sleep_unless(POLL, &is_draining);
                continue;
            }
        };
        brake.after(false, POLL);
        idle = 0;
        let label = task_label(&task);
        say(format!(
            "task {}: {label} (attempt {}/{})",
            task.id, task.attempts, task.max_attempts
        ));
        let token = Arc::new(Mutex::new(token));
        let stop = Arc::new(Mutex::new(false));
        let beat = heartbeat(opts.api.clone(), task.id, token.clone(), stop.clone());
        let started = Instant::now();
        let outcome = execute(opts, &task, &token);
        *stop.lock().unwrap() = true;
        let _ = beat.join();
        let took = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let token = token.lock().unwrap().clone();
        // The report never ends the worker: a pool that refuses it (a task
        // cancelled, or taken back just as it finished: 409) or does not
        // answer (5xx) is logged, and the loop claims again (#277).
        match Api::new(&opts.api, &token) {
            Ok(job) => report(&job, &token, &task, outcome, took),
            Err(e) => say(format!(
                "task {}: could not report it ({e}); its lease ends by itself",
                task.id
            )),
        }
        done += 1;
        if opts.once {
            eprintln!("{done} task(s) done; exiting");
            return Ok(());
        }
    }
}

/// Tells the pool how the task ended: complete with the outcome, or fail
/// with the error (the pool requeues or gives up by the attempt count).
/// Whatever the pool answers is logged, never a reason to exit: a `complete`
/// refused with 409 or 5xx used to end the process under `?`, and the
/// restart policy started it again (#277).
fn report(job: &Api, token: &str, task: &Task, outcome: Result<Outcome>, took: u64) {
    match outcome {
        Ok(o) => {
            let field =
                |k: &str, default: serde_json::Value| o.result.get(k).cloned().unwrap_or(default);
            let dash = || serde_json::Value::String("-".into());
            match job.post_json_as(
                token,
                &format!("/factory/tasks/{}/complete", task.id),
                &serde_json::json!({ "summary": o.summary, "result": o.result, "duration_ms": took,
                    "sha256": field("sha256", dash()), "filename": field("filename", dash()), "version": field("version", serde_json::Value::Null) }),
            ) {
                Ok(_) => say(format!(
                    "task {}: done — {} ({} s)",
                    task.id,
                    o.summary,
                    took / 1000
                )),
                Err(e) => say(format!(
                    "the pool refused the report of task {}: {}; moving on",
                    task.id,
                    orders::clean_line(&e.to_string())
                )),
            }
        }
        Err(e) => {
            if let Err(refused) = job.post_json_as(
                token,
                &format!("/factory/tasks/{}/fail", task.id),
                &fail_body(&e, took),
            ) {
                say(format!(
                    "the pool refused the report of task {}: {}; moving on",
                    task.id,
                    orders::clean_line(&refused.to_string())
                ));
            }
            if e.downcast_ref::<NeedsNative>().is_some() {
                say(format!(
                    "task {}: failed, this worker's — back in the queue for a native {} worker — {e:#}",
                    task.id, task.arch
                ));
            } else {
                say(format!("task {}: failed — {e:#}", task.id));
            }
        }
    }
}

/// A process under this many seconds old refuses a restart: a restart this
/// soon would loop, and the engine applies a restart policy only after 10 s.
const RESTART_MIN_UPTIME: Duration = Duration::from_secs(120);
/// A re-check reuses a probe under a minute old; a conditional restart's check, one under 15 s.
const RECHECK_REUSE: Duration = Duration::from_secs(60);
const RESTART_REUSE: Duration = Duration::from_secs(15);
/// How long a restarted agent service has to answer on its port.
const SIBLING_WAIT: Duration = Duration::from_secs(180);

/// What this process is, for the pool (#277, the design's §1.2 and §1.14):
/// drawn once at start and said with every claim; the pool writes it only
/// when it changes.
struct Process {
    instance: String,
    started: Instant,
    started_iso: String,
    /// The kinds this process executes, and drain (it understands notices).
    takes: Vec<&'static str>,
    agent_via: &'static str,
    site: Option<String>,
    restarts_left: Option<i64>,
    /// Its own container, verified: the runtime that runs it, its id, its compose project.
    runtime: Option<String>,
    project: Option<String>,
    /// The agent service it calls, a service of its own project (restart-agent).
    sibling: Option<String>,
    state_dir: PathBuf,
    previous_exit: Option<serde_json::Value>,
    reread_at: Instant,
    /// The spell whose sibling's log went to this worker's log already: once per spell.
    relayed: bool,
}

impl Process {
    fn start(opts: &WorkOptions, has_agent: bool) -> Self {
        let instance = orders::new_instance();
        let state_dir = orders::state_dir(&opts.work_dir);
        let previous_exit = orders::take_exit_note(&state_dir);
        let supervised = std::env::var("OMARCHY_SUPERVISED").is_ok_and(|v| v == "1");
        let own = identify(&instance);
        if own.is_none() && Path::new("/.dockerenv").exists() {
            say("cannot identify its own container (no verified self-inspect): no site, no restart of its agent service; restart only under OMARCHY_SUPERVISED=1");
        }
        let (restart, restarts_left) =
            orders::declares_restart(own.as_ref().map(|o| &o.inspect), supervised);
        let sibling = own.as_ref().and_then(|o| {
            let host = std::env::var("ANTHROPIC_BASE_URL")
                .ok()
                .as_deref()
                .and_then(orders::url_host)?;
            sibling_of(&o.runtime, o.inspect.project.as_deref()?, &host).map(|_| host)
        });
        let site = own
            .as_ref()
            .and_then(|o| engine_site(&o.runtime, o.inspect.project.as_deref()));
        let mut takes = vec!["drain"];
        if has_agent {
            takes.push("recheck-agent");
        }
        if restart {
            takes.push("restart");
        }
        if has_agent && sibling.is_some() {
            takes.push("restart-agent");
        }
        takes.sort_unstable();
        Self {
            instance,
            started: Instant::now(),
            started_iso: chrono_now(),
            takes,
            agent_via: if !has_agent {
                "none"
            } else if sibling.is_some() {
                "sibling"
            } else {
                "direct"
            },
            site,
            restarts_left,
            runtime: own.as_ref().map(|o| o.runtime.clone()),
            project: own.and_then(|o| o.inspect.project),
            sibling,
            state_dir,
            previous_exit,
            reread_at: Instant::now(),
            relayed: false,
        }
    }

    /// The site again every ten minutes, from two reads of the engine's id that agree — so it cannot flip between claims.
    fn reread(&mut self) {
        if self.reread_at.elapsed() < Duration::from_secs(600) {
            return;
        }
        self.reread_at = Instant::now();
        if let Some(rt) = &self.runtime {
            self.site = engine_site(rt, self.project.as_deref());
        }
    }

    /// What the claim says of this process; the previous one's end only in the first.
    fn say_in(&mut self, body: &mut serde_json::Value) {
        body["orders"] = serde_json::json!(self.takes);
        body["instance"] = serde_json::json!(self.instance);
        body["started_at"] = serde_json::json!(self.started_iso);
        body["agent_via"] = serde_json::json!(self.agent_via);
        body["restarts_left"] = serde_json::json!(self.restarts_left);
        if let Some(site) = &self.site {
            body["site"] = serde_json::json!(site);
        }
        if let Some(prev) = self.previous_exit.take() {
            body["previous_exit"] = prev;
        }
    }

    /// Before a deliberate exit: why, for the next process to tell the pool.
    fn leave(&self, why: &str) {
        orders::leave_exit_note(&self.state_dir, why, &chrono_now());
    }

    /// Once per not-ready spell, the sibling agent service's last lines go into this worker's log (its owner and the maintainers read it): what `docker compose logs agent-proxy` over SSH used to show.
    fn relay_sibling_log(&mut self, check: &AgentCheck) {
        if check.probe.status != "error" {
            self.relayed = false;
            return;
        }
        if self.relayed {
            return;
        }
        if let (Some(rt), Some(project), Some(host)) = (&self.runtime, &self.project, &self.sibling)
        {
            if let Some(cid) = sibling_of(rt, project, host) {
                self.relayed = true;
                if let Ok(out) = Command::new(rt)
                    .args(["logs", "--tail", "50", &cid])
                    .output()
                {
                    let text = [
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr),
                    ]
                    .concat();
                    for line in text.lines().filter(|l| !l.trim().is_empty()) {
                        say(format!("[{host}] {}", orders::clean_line(line)));
                    }
                }
            }
        }
    }
}

/// Its own container, verified: the runtime, the id, what inspect says.
struct Own {
    runtime: String,
    inspect: orders::Inspect,
}

/// Which container this process runs in (§1.14 of #277's design): the
/// candidates from its own mounts, each verified by reading back, through
/// the runtime, the instance this process wrote at start — a candidate that
/// does not answer with it is not this container. None without a runtime
/// that answers, or without a verified candidate.
fn identify(instance: &str) -> Option<Own> {
    let dir = Path::new("/run/omarchy");
    if std::fs::create_dir_all(dir).is_err()
        || std::fs::write(dir.join("instance"), instance).is_err()
    {
        return None;
    }
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    let env = std::fs::read_to_string("/run/.containerenv").ok();
    let host = std::fs::read_to_string("/etc/hostname").ok();
    let candidates = orders::container_candidates(&mountinfo, env.as_deref(), host.as_deref());
    if candidates.is_empty() {
        return None;
    }
    let runtime = ["docker", "podman"].iter().find(|r| {
        Command::new(r)
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    })?;
    for cid in candidates {
        let read = Command::new(runtime)
            .args(["exec", &cid, "cat", "/run/omarchy/instance"])
            .output();
        if !read.is_ok_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == instance
        }) {
            continue;
        }
        let out = Command::new(runtime)
            .args(["inspect", &cid])
            .output()
            .ok()?;
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        return orders::parse_inspect(&v).map(|inspect| Own {
            runtime: (*runtime).to_owned(),
            inspect,
        });
    }
    None
}

/// The site of this compose project on this engine: only from an engine id two reads a second apart agree on.
fn engine_site(runtime: &str, project: Option<&str>) -> Option<String> {
    let project = project?;
    let read = || {
        Command::new(runtime)
            .args(["info", "-f", "{{.ID}}"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_default()
    };
    let a = read();
    std::thread::sleep(Duration::from_secs(1));
    orders::site_of(&a, &read(), project)
}

/// The container of the service `host` of this project, when there is exactly one and its role is `agent` or `broker` — read with a template that extracts that one variable, never the others (they hold its keys).
fn sibling_of(runtime: &str, project: &str, host: &str) -> Option<String> {
    let out = Command::new(runtime)
        .args([
            "ps",
            "-q",
            "--filter",
            &format!("label=com.docker.compose.project={project}"),
            "--filter",
            &format!("label=com.docker.compose.service={host}"),
        ])
        .output()
        .ok()?;
    let ids: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    let [cid] = ids.as_slice() else { return None };
    let role = Command::new(runtime)
        .args(["inspect", "-f", r#"{{range .Config.Env}}{{if eq (index (split . "=") 0) "OMARCHY_WORKER_ROLE"}}{{.}}{{end}}{{end}}"#, cid])
        .output()
        .ok()?;
    let role = String::from_utf8_lossy(&role.stdout);
    matches!(
        role.trim(),
        "OMARCHY_WORKER_ROLE=agent" | "OMARCHY_WORKER_ROLE=broker"
    )
    .then(|| cid.clone())
}

/// Where a worker's answers go: the pool, with its own token and this process — only this process's answer counts.
struct Reply<'a> {
    claimer: &'a Api,
    token: &'a str,
    instance: &'a str,
}

/// The worker's refusal of an order, with the kind's code and its own words.
fn refuse(to: &Reply, o: &Order, code: &str, detail: &str) {
    answer(to, o, "refused", code, detail, &serde_json::json!({}));
}

/// The worker's answer to an order: an outcome, the kind's code, its own words (private to its owner and the maintainers), and what else it has (its agent's answer, the service it restarted).
fn answer(
    to: &Reply,
    o: &Order,
    outcome: &str,
    code: &str,
    detail: &str,
    extra: &serde_json::Value,
) {
    let (claimer, token) = (to.claimer, to.token);
    let mut body = serde_json::json!({ "instance": to.instance, "outcome": outcome, "code": code, "detail": detail });
    if let (Some(b), Some(x)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in x {
            b.insert(k.clone(), v.clone());
        }
    }
    if let Err(e) = claimer.post_json_as(
        token,
        &format!("/factory/workers/self/orders/{}", o.id),
        &body,
    ) {
        say(format!(
            "order {}: the answer did not reach the pool ({}); it closes the order by what it sees",
            o.id,
            orders::clean_line(&e.to_string())
        ));
    }
}

fn agent_json(p: &AgentProbe) -> serde_json::Value {
    serde_json::json!({ "agent": { "status": p.status, "error": p.error, "ms": p.ms, "checked_at": p.checked_iso } })
}

/// Obeys one order (§1.8.2 of #277's design): re-check the agent, restart —
/// conditionally when asked, never a process under two minutes old — or
/// restart the agent service of its own host; a drain is a notice; a kind it
/// does not know is refused by name. Each id at most once.
fn obey(
    opts: &WorkOptions,
    claimer: &Api,
    me: &mut Process,
    check: &mut AgentCheck,
    seen: &mut orders::Seen,
    o: &Order,
) {
    if !seen.first(&o.id) {
        say(format!("order {}: executed already; ignored", o.id));
        return;
    }
    say(format!(
        "order {}: {} from {} — {}",
        o.id,
        o.kind.name(),
        if o.issued_by.is_empty() {
            "?"
        } else {
            &o.issued_by
        },
        o.reason
    ));
    let instance = me.instance.clone();
    let to = Reply {
        claimer,
        token: &opts.worker_token,
        instance: &instance,
    };
    let takes = |k: &str| me.takes.contains(&k);
    // A probe for an order: stored and logged, the worker's own backoff left alone.
    let probe_now = |check: &mut AgentCheck, reuse: Duration| {
        if !check.fresh(reuse) {
            if let Some(line) = check.record_ordered(probe_agent(opts)) {
                say(line);
            }
        }
    };
    match &o.kind {
        OrderKind::Drain => say(format!(
            "drained by {} — the pool hands me nothing until it is resumed",
            o.issued_by
        )),
        OrderKind::RecheckAgent if takes("recheck-agent") => {
            // A person's re-check reuses a probe under a minute old: it spends no completion for nothing. The pool's is
            // issued only once the probe is stale on the pool's clock (its RECHECK_AFTER_MIN), and always asks.
            probe_now(
                check,
                if o.issued_by == "pool" {
                    Duration::ZERO
                } else {
                    RECHECK_REUSE
                },
            );
            let p = check.probe.clone();
            let detail = if p.status == "ok" {
                format!("agent answers ({} ms)", p.ms)
            } else {
                format!("agent does not answer: {}", p.error)
            };
            answer(&to, o, "done", "probed", &detail, &agent_json(&p));
        }
        OrderKind::Restart if takes("restart") => restart_self(opts, &to, me, check, o),
        OrderKind::RestartAgent if takes("restart-agent") => {
            restart_agent(opts, claimer, me, check, o);
        }
        other => {
            let code = match other {
                OrderKind::Unknown(_) => "unknown-kind",
                OrderKind::Restart => "no-policy",
                OrderKind::RestartAgent => "not-a-sibling",
                _ => "other",
            };
            answer(
                &to,
                o,
                "refused",
                code,
                &format!(
                    "this worker ({}) does not take {}",
                    pkg_manifest::BUILD_VERSION,
                    other.name()
                ),
                &serde_json::json!({}),
            );
        }
    }
}

/// A restart (§1.8.2): refused by a process under two minutes old — a
/// restart this soon would loop — and, when the order asks, by one whose
/// agent answers now; otherwise accepted, the note left for the next
/// process, and exit 75: the restart policy starts it again.
fn restart_self(opts: &WorkOptions, to: &Reply, me: &Process, check: &mut AgentCheck, o: &Order) {
    if me.started.elapsed() < RESTART_MIN_UPTIME {
        refuse(
            to,
            o,
            "too-young",
            &format!(
                "started {} s ago: a restart this soon would loop",
                me.started.elapsed().as_secs()
            ),
        );
        return;
    }
    if o.unless_agent_ok {
        if !check.fresh(RESTART_REUSE) {
            if let Some(line) = check.record_ordered(probe_agent(opts)) {
                say(line);
            }
        }
        if check.probe.status == "ok" {
            let p = check.probe.clone();
            answer(
                to,
                o,
                "refused",
                "agent-ok",
                &format!("agent answers now ({} ms): no restart needed", p.ms),
                &agent_json(&p),
            );
            return;
        }
    }
    answer(
        to,
        o,
        "accepted",
        "exiting",
        "exit 75; the restart policy starts it again",
        &serde_json::json!({}),
    );
    say(format!(
        "order {}: restarting — exit 75, the restart policy starts this worker again",
        o.id
    ));
    me.leave("restart");
    std::process::exit(75);
}

/// After the agent service restarted and answered (or three minutes passed): the worker's own agent asked again, and the answer — restarted, or still not answering.
fn after_sibling_restart(
    opts: &WorkOptions,
    to: &Reply,
    check: &mut AgentCheck,
    o: &Order,
    host: &str,
    seconds: u64,
) {
    if let Some(line) = check.record_ordered(probe_agent(opts)) {
        say(line);
    }
    let p = check.probe.clone();
    let mut extra = agent_json(&p);
    extra["service"] = serde_json::json!(host);
    extra["seconds"] = serde_json::json!(seconds);
    if p.status == "ok" {
        answer(
            to,
            o,
            "done",
            "restarted",
            &format!("restarted {host}; it answers after {seconds} s"),
            &extra,
        );
    } else {
        answer(
            to,
            o,
            "failed",
            "not-answering",
            &format!(
                "restarted {host}; the agent still does not answer after {seconds} s: {}",
                p.error
            ),
            &extra,
        );
    }
}

/// Does the agent service answer on its port, from inside its own container — the rollout's own test (`answers()`, #278).
fn sibling_answers(rt: &str, cid: &str) -> bool {
    Command::new(rt)
        .args([
            "exec",
            cid,
            "curl",
            "-s",
            "-o",
            "/dev/null",
            "--max-time",
            "3",
            "http://127.0.0.1:8790/",
        ])
        .output()
        .is_ok_and(|r| r.status.success())
}

/// Restarts the agent service this worker calls on its own host (§1.13): a
/// fresh probe first — an agent that answers is not restarted —, the service
/// found again as at start, restarted, waited for on its port (at most
/// three minutes), and the worker's own agent asked again. The service's
/// last lines go to this worker's log first.
fn restart_agent(
    opts: &WorkOptions,
    claimer: &Api,
    me: &mut Process,
    check: &mut AgentCheck,
    o: &Order,
) {
    let instance = me.instance.clone();
    let to = Reply {
        claimer,
        token: &opts.worker_token,
        instance: &instance,
    };
    if let Some(line) = check.record_ordered(probe_agent(opts)) {
        say(line);
    }
    if check.probe.status == "ok" {
        let p = check.probe.clone();
        answer(
            &to,
            o,
            "refused",
            "agent-ok",
            &format!("agent answers now ({} ms): nothing to restart", p.ms),
            &agent_json(&p),
        );
        return;
    }
    let (Some(rt), Some(project), Some(host)) =
        (me.runtime.clone(), me.project.clone(), me.sibling.clone())
    else {
        refuse(
            &to,
            o,
            "not-a-sibling",
            "it calls no agent service of its own host",
        );
        return;
    };
    let Some(cid) = sibling_of(&rt, &project, &host) else {
        refuse(
            &to,
            o,
            "not-a-sibling",
            &format!("{host} is no agent service of this project now"),
        );
        return;
    };
    me.relayed = false;
    me.relay_sibling_log(check);
    answer(
        &to,
        o,
        "accepted",
        "restarting",
        &format!("restarting {host}"),
        &serde_json::json!({ "service": host }),
    );
    let started = Instant::now();
    let restarted = Command::new(&rt)
        .args(["restart", "-t", "30", &cid])
        .output();
    if !restarted.as_ref().is_ok_and(|r| r.status.success()) {
        let why = restarted.map_or_else(
            |e| e.to_string(),
            |r| String::from_utf8_lossy(&r.stderr).trim().to_owned(),
        );
        answer(
            &to,
            o,
            "failed",
            "docker-error",
            &format!("{rt} restart {host}: {}", orders::clean_line(&why)),
            &serde_json::json!({ "service": host }),
        );
        return;
    }
    while !sibling_answers(&rt, &cid) && started.elapsed() < SIBLING_WAIT {
        std::thread::sleep(Duration::from_secs(2));
    }
    let seconds = started.elapsed().as_secs();
    after_sibling_restart(opts, &to, check, o, &host, seconds);
}

/// What `/factory/tasks/:id/fail` hears. A failed gate is the recipe's
/// failure: the next fresh container fails it the same way — final, as the
/// community worker reports. A build that died of emulation is this
/// worker's (`NeedsNative`): not final, and `needs_native` sends it back to
/// the queue for a native worker of its architecture, the attempt given
/// back — the pool hands it to no emulated worker again.
fn fail_body(e: &anyhow::Error, took: u64) -> serde_json::Value {
    let msg = format!("{e:#}");
    let native = e.downcast_ref::<NeedsNative>().is_some();
    let last = !native && msg.contains("— the gate");
    serde_json::json!({ "error": msg, "duration_ms": took, "log_tail": msg, "final": last, "needs_native": native })
}

/// A build this worker cannot run, whatever the recipe says: it runs
/// emulated (`x86_64` under qemu on an `aarch64` host), and on a 16 KB-page
/// kernel qemu cannot map every `x86_64` library — rustc (libLLVM, libedit),
/// sudo (libldap) and their like die on load. A native worker of the
/// architecture builds it; the report says so (`needs_native`), as the
/// community worker's does (omarchy-build-worker.sh, exit 96).
#[derive(Debug)]
struct NeedsNative(String);

impl std::fmt::Display for NeedsNative {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NeedsNative {}

/// The worker's labels say it runs emulated (`{"emulated":true}`), read as
/// the pool reads them (routes/factory.ts: any value JavaScript counts
/// true) and as the build script does (omarchy-build-worker.sh,
/// `emulated_worker`): the worker and the pool never disagree on which
/// one it is, so a `needs_native` it sends is one the pool heeds.
fn emulated(labels: &serde_json::Value) -> bool {
    use serde_json::Value;
    match labels.get("emulated") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// Why a failed build container died of emulation, or None when it did
/// not: the build script's own exit 96 (`toolchains_start`: a toolchain the
/// recipe installed does not start; `libraries_start`: a library qemu could
/// not map, sudo or anything linking libedit or libldap), its line for it,
/// or — on an emulated worker — the loader's own words where the script
/// did not see them (outside makepkg). The markers are the community
/// worker's, the same script's; a native worker's "failed to map segment"
/// is a real failure.
fn emulation_failure(emulated: bool, code: Option<i32>, log: &str) -> Option<String> {
    const CANNOT_START: &str = "cannot start on this worker";
    const CANNOT_MAP: &str = "failed to map segment from shared object";
    let line = |marker: &str| {
        log.lines()
            .find(|l| l.contains(marker))
            .map(|l| l.trim().trim_start_matches("==> ").to_owned())
    };
    if code == Some(96) || (emulated && log.contains(CANNOT_START)) {
        return Some(
            line(CANNOT_START)
                .unwrap_or_else(|| "a toolchain cannot start on this emulated worker".to_owned()),
        );
    }
    if emulated {
        return line(CANNOT_MAP).map(|l| {
            format!("{l} — emulated under qemu on a host whose page size is not the guest's; a native worker is needed for this package")
        });
    }
    None
}

/// Sleeps `d`, a second at a time, unless `stop` says so first.
fn sleep_unless(d: Duration, stop: &dyn Fn() -> bool) {
    let end = Instant::now() + d;
    while Instant::now() < end && !stop() {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn task_label(t: &Task) -> String {
    let p = &t.params;
    match t.kind.as_str() {
        "sync" => format!(
            "sync {}/{} → {}",
            s(p, "source"),
            s(p, "arch"),
            s(p, "ring")
        ),
        "promote" => format!("promote {} → {}", s(p, "from"), s(p, "to")),
        "security" => "security: advisories, matches, fast-track".to_owned(),
        "rollback" => format!("rollback {} → release {}", s(p, "ring"), s(p, "to")),
        "enqueue" => "enqueue: PKGBUILDs on main → the queue".to_owned(),
        "audit" => format!(
            "audit {} (staged task {})",
            s(p, "name"),
            p.get("task").map(ToString::to_string).unwrap_or_default()
        ),
        "verify" => "verify: do the served OPR objects verify?".to_owned(),
        "render" | "health" => format!("{} {}/{}", t.kind, s(p, "ring"), s(p, "arch")),
        _ => format!("{} {}", t.kind, t.name),
    }
}

fn s(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_owned()
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "worker".to_owned())
}

/// Keeps the lease — and the job token, which moves with it — while the work runs.
fn heartbeat(
    api: String,
    task: u64,
    token: Arc<Mutex<String>>,
    stop: Arc<Mutex<bool>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut waited = Duration::ZERO;
        loop {
            std::thread::sleep(Duration::from_secs(5));
            waited += Duration::from_secs(5);
            if *stop.lock().unwrap() {
                return;
            }
            if waited < HEARTBEAT {
                continue;
            }
            waited = Duration::ZERO;
            let current = token.lock().unwrap().clone();
            if let Ok(client) = Api::new(&api, &current) {
                if let Ok(Some(v)) = client.post_json_as(
                    &current,
                    &format!("/factory/tasks/{task}/heartbeat"),
                    &serde_json::json!({}),
                ) {
                    if let Some(t) = v.get("token").and_then(|t| t.as_str()) {
                        t.clone_into(&mut token.lock().unwrap());
                    }
                }
            }
        }
    })
}

fn execute(opts: &WorkOptions, task: &Task, token: &Arc<Mutex<String>>) -> Result<Outcome> {
    let job = Api::new(&opts.api, &token.lock().unwrap().clone())?;
    match task.kind.as_str() {
        "sync" => sync_job(opts, &job, task),
        "render" => {
            let ring = s(&task.params, "ring");
            let arch = s(&task.params, "arch");
            let r = ops::render(&job, &ring, &arch, opts.sign.as_deref())?;
            Ok(Outcome {
                summary: format!("{ring}/{arch} rendered: {}", r.join(", ")),
                result: serde_json::json!({ "repos": r }),
            })
        }
        "promote" => promote_job(opts, &job, task, token),
        "security" => security_job(opts, &job, token),
        "rollback" => rollback_job(opts, &job, task),
        "enqueue" => {
            let r = crate::reconcile::run(&job, &opts.work_dir, &opts.arch)?;
            Ok(Outcome {
                summary: format!(
                    "main@{}: {} queued, {} skipped, {} up to date{}",
                    &r.commit[..r.commit.len().min(7)],
                    r.queued.len(),
                    r.skipped.len(),
                    r.up_to_date,
                    if r.queued.is_empty() {
                        String::new()
                    } else {
                        format!(" — {}", r.queued.join("; "))
                    }
                ),
                result: serde_json::json!({ "commit": r.commit, "queued": r.queued, "skipped": r.skipped, "up_to_date": r.up_to_date }),
            })
        }
        "health" => {
            let ring = s(&task.params, "ring");
            let arch = s(&task.params, "arch");
            let ok = script(opts, token, "tests/health-check.sh", &[&ring, &arch])?;
            if ok {
                Ok(Outcome {
                    summary: format!("{ring}/{arch} healthy"),
                    result: serde_json::json!({ "ok": true }),
                })
            } else {
                Err(anyhow!(
                    "health check of {ring}/{arch} failed (see the health event)"
                ))
            }
        }
        "gc" => {
            let keep = u32::try_from(
                task.params
                    .get("keep")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(3),
            )
            .unwrap_or(3);
            ops::gc(&job, keep, true)?;
            Ok(Outcome {
                summary: format!("retention: kept the last {keep} releases per ring"),
                result: serde_json::json!({ "keep": keep }),
            })
        }
        "build" => build_job(opts, task, token),
        "publish" => publish_job(opts, &job, task),
        "audit" => audit_job(opts, &job, task),
        "verify" => verify_job(opts, &job, task),
        "relayout" => relayout_job(opts, token),
        "trial" => trial_job(opts, &job, task, token),
        other => Err(anyhow!("this worker does not run '{other}' jobs")),
    }
}

/// Was the file written less than `max` ago?
fn fresh_within(stamp: &Path, max: Duration) -> bool {
    match stamp.metadata().and_then(|m| m.modified()) {
        Ok(t) => t.elapsed().is_ok_and(|e| e < max),
        Err(_) => false,
    }
}

/// The repository checkout the scripts live in, cloned at this binary's version when missing.
/// `$OMARCHY_PKG_CACHE/<arch>`, created, when the operator shares a pacman
/// package cache with the build containers (a path on the host: the
/// runtime mounts it, so it must be the same on both sides).
fn pkg_cache_dir(arch: &str) -> Result<Option<PathBuf>> {
    cache_dir("OMARCHY_PKG_CACHE", arch)
}

/// `$<var>/<sub>`, created, when the variable names a directory on the
/// host to share with the build containers.
fn cache_dir(var: &str, sub: &str) -> Result<Option<PathBuf>> {
    let Some(root) = std::env::var_os(var) else {
        return Ok(None);
    };
    if root.is_empty() {
        return Ok(None);
    }
    let dir = PathBuf::from(root).join(sub);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {var} {}", dir.display()))?;
    Ok(Some(dir))
}

fn repo_dir(opts: &WorkOptions) -> Result<PathBuf> {
    if let Some(d) = &opts.repo_dir {
        return Ok(d.clone());
    }
    let dir = opts.work_dir.join("repo");
    let stamp = dir.join(".fetched");
    let version = pkg_manifest::BUILD_VERSION;
    let git_ref = if version.starts_with('v') {
        version.to_owned()
    } else {
        "main".to_owned()
    };
    // The checkout is the release this binary came from: a fresh stamp from
    // another ref is another release's scripts. The review worker upgraded
    // to v0.0.116 kept the day-old checkout its predecessor cloned, ran the
    // old agent.py against the new environment, and nineteen audits died on
    // "FACTORY_PROVIDER must be one of …" (2026-09-15).
    let fresh = fresh_within(&stamp, Duration::from_secs(86400))
        && std::fs::read_to_string(&stamp).is_ok_and(|s| s.trim() == git_ref);
    if dir.join("tests").is_dir() && fresh {
        return Ok(dir);
    }
    // A fresh clone lands beside the old checkout and replaces it only once
    // it is whole: when GitHub does not answer, the checkout the worker has
    // — the same release's scripts — carries on, and the pool says so. The
    // pool's rule since 2026-09-17: builds go on when GitHub is down.
    let fresh_dir = opts.work_dir.join("repo.new");
    let _ = std::fs::remove_dir_all(&fresh_dir);
    let mut ok = Command::new("git")
        .args([
            "clone", "-q", "--depth", "1", "--branch", &git_ref, REPO_URL,
        ])
        .arg(&fresh_dir)
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        // A dev build's version has no tag; main is what it was built from.
        let _ = std::fs::remove_dir_all(&fresh_dir);
        ok = Command::new("git")
            .args(["clone", "-q", "--depth", "1", REPO_URL])
            .arg(&fresh_dir)
            .status()
            .is_ok_and(|s| s.success());
    }
    if ok {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&fresh_dir, &dir).context("moving the fresh checkout into place")?;
        std::fs::write(&stamp, git_ref)?;
        return Ok(dir);
    }
    let _ = std::fs::remove_dir_all(&fresh_dir);
    // Only this release's own checkout goes on: another release's scripts
    // are the v0.0.116 incident again (nineteen audits died on an old
    // agent.py, 2026-09-15). A rollout during an outage cannot happen
    // anyway — the image comes from the same place.
    let have = std::fs::read_to_string(&stamp).unwrap_or_default();
    if dir.join("tests").is_dir() && have.trim() == git_ref {
        eprintln!("warning: could not clone {REPO_URL}; going on with the checkout of {git_ref} the worker has");
        return Ok(dir);
    }
    anyhow::bail!(
        "could not clone {REPO_URL}, and the checkout here is {} — not this release's ({git_ref})",
        if have.trim().is_empty() {
            "missing"
        } else {
            have.trim()
        }
    )
}

/// The keyring files the sync verifies against, refreshed daily by the pipeline's own script.
fn keyrings(opts: &WorkOptions) -> Result<PathBuf> {
    keyrings_for(opts, &[])
}

/// The same, but a keyring the task names and the directory lacks brings the
/// refresh forward: a source added with its own key (asahi-alarm, the Asahi
/// fork on 2026-09-15) must not fail for a day because yesterday's stamp is
/// still fresh.
fn keyrings_for(opts: &WorkOptions, required: &[String]) -> Result<PathBuf> {
    let dir = opts.work_dir.join("keyrings");
    let stamp = dir.join(".fetched");
    let fresh = fresh_within(&stamp, Duration::from_secs(86400));
    let present = |name: &str| dir.join(format!("{name}.gpg")).exists();
    if fresh && present("archlinux") && required.iter().all(|k| present(k)) {
        return Ok(dir);
    }
    let repo = repo_dir(opts)?;
    std::fs::create_dir_all(&dir)?;
    let status = Command::new("bash")
        .arg(repo.join("tests/fetch-keyrings.sh"))
        .arg(&dir)
        .status()
        .context("fetch-keyrings.sh")?;
    if !status.success() {
        // The keyrings come from GitHub (omarchy-iso, asahi-alarm): when it
        // does not answer, yesterday's keyrings verify today's packages as
        // well as they did yesterday — the sync goes on, and says so. Only
        // a keyring the worker never had stops it.
        if present("archlinux") && required.iter().all(|k| present(k)) {
            eprintln!("warning: the upstream keyrings could not be refreshed; going on with the ones here");
            return Ok(dir);
        }
        anyhow::bail!("fetching the upstream keyrings failed, and a required one is not here yet");
    }
    std::fs::write(&stamp, "")?;
    Ok(dir)
}

/// One upstream source's sync options, from the task's parameters.
fn sync_options(
    opts: &WorkOptions,
    p: &serde_json::Value,
    keys: &Path,
    defer_release: bool,
) -> SyncOptions {
    let defer: Vec<String> = s(p, "defer_to")
        .split(',')
        .filter(|d| !d.is_empty())
        .map(str::to_owned)
        .collect();
    SyncOptions {
        source: s(p, "source"),
        upstream: String::new(),
        base_url: Some(s(p, "base_url")),
        db_name: Some(s(p, "db_name")),
        arch: s(p, "arch"),
        ring: s(p, "ring"),
        limit: 0,
        concurrency: 8,
        work_dir: opts.work_dir.join("sync"),
        dry_run: false,
        keyring: Some(keys.join(format!("{}.gpg", s(p, "keyring")))),
        defer_to: defer,
        defer_release,
    }
}

/// Renders a ring's databases for `arch` and for the other architecture,
/// except the ones the pool says a release left exactly as its parent
/// (`unchanged`): those are already rendered at the live keys and the
/// release carries their artifact rows.
fn render_both(
    opts: &WorkOptions,
    job: &Api,
    ring: &str,
    arch: &str,
    unchanged: &[String],
) -> Result<Vec<String>> {
    let other = if arch == "aarch64" {
        "x86_64"
    } else {
        "aarch64"
    };
    let mut rendered = Vec::new();
    for a in [arch, other] {
        if unchanged.iter().any(|u| u == a) {
            eprintln!("{ring}/{a}: unchanged since the parent release; databases kept");
            continue;
        }
        rendered.extend(ops::render(job, ring, a, opts.sign.as_deref())?);
    }
    Ok(rendered)
}

/// What one ring accumulates across the sources of a batched sync.
#[derive(Default)]
struct Pending {
    add: Vec<String>,
    /// `(source, name)`: each source drops from its own rows only.
    remove: Vec<(String, String)>,
    notes: Vec<String>,
}

/// The sync job. `params.sources` (a JSON list of source configurations,
/// all of one architecture) syncs them in turn and pins the result as
/// **one release per ring** — a release copies the ring's whole selection
/// and D1 bills every row written, so eleven sources an hour must not
/// mean eleven releases. A task with a single source (`params.source`,
/// the old form, and `pkg-repo job sync --param source=…`) pins its own.
/// Uploads a build's evidence files to the task's staging space, the ones
/// that exist: `at_dir` from the task directory, `at_out` from its `out/`.
fn stage_evidence(job: &Api, task: u64, dir: &Path, at_dir: &[&str], at_out: &[&str]) {
    let files = at_dir.iter().map(|f| (dir.join(f), (*f).to_owned())).chain(
        at_out
            .iter()
            .map(|f| (dir.join("out").join(f), (*f).to_owned())),
    );
    for (path, name) in files {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Err(e) =
                job.put_bytes(&format!("/factory/tasks/{task}/artifacts/{name}"), &bytes)
            {
                eprintln!("task {task}: {name} not staged: {e}");
            }
        }
    }
}

/// The publish job: the project's approved build, from its staging space
/// into the pool — the packages the approval listed, downloaded with this
/// job's token (a package in staging is for maintainers and for this job),
/// published into edge as source `factory` (the pool signs), edge rendered
/// for both architectures. What users get.
fn publish_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let built = task
        .params
        .get("task")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| anyhow!("publish: params.task names the project's build"))?;
    let files: Vec<String> = task
        .params
        .get("files")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    anyhow::ensure!(
        !files.is_empty(),
        "publish: params.files lists the staged packages"
    );
    let dir = opts.work_dir.join(format!("publish-{}", task.id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let mut pkgs = Vec::new();
    for f in &files {
        anyhow::ensure!(
            f.ends_with(".pkg.tar.zst") && !f.contains('/'),
            "publish: {f} is not a package file name"
        );
        let dest = dir.join(f);
        job.download_as_self(
            &format!("{}/api/v1/factory/tasks/{built}/artifacts/{f}", job.base()),
            &dest,
        )
        .with_context(|| format!("fetching {f} of the project's build {built}"))?;
        pkgs.push(dest);
    }
    pkgs.sort();
    ops::publish(
        job,
        "edge",
        "factory",
        &task.arch,
        Some(&format!(
            "factory task {built}: {} approved ({})",
            task.name,
            s(&task.params, "by")
        )),
        &pkgs,
    )?;
    let mut rendered = ops::render(job, "edge", &task.arch, opts.sign.as_deref())?;
    let other = if task.arch == "aarch64" {
        "x86_64"
    } else {
        "aarch64"
    };
    rendered.extend(ops::render(job, "edge", other, opts.sign.as_deref())?);
    let main = pkgs
        .iter()
        .find(|p| {
            p.file_name()
                .is_some_and(|f| f.to_string_lossy().starts_with(&format!("{}-", task.name)))
        })
        .unwrap_or(&pkgs[0]);
    let manifest = pkg_extract::extract_manifest(main)?;
    let fast = if s(&task.params, "trial") == "ok" {
        fast_lane(opts, job, task, built, &pkgs, &manifest, &mut rendered)?
    } else {
        Vec::new()
    };
    let _ = std::fs::remove_dir_all(&dir);
    Ok(Outcome {
        summary: format!(
            "{} {} — the project's build {built}, approved — published into edge{} for {} ({})",
            manifest.name,
            manifest.version,
            if fast.is_empty() {
                String::new()
            } else {
                format!(", fast-tracked to {}", fast.join(" and "))
            },
            task.arch,
            rendered.join(", ")
        ),
        result: serde_json::json!({ "sha256": manifest.sha256, "filename": manifest.filename, "version": manifest.version, "rendered": rendered, "task": built, "fast_track": fast }),
    })
}

/// The fast lane: a build a real pacman installed from the lab (the trial
/// said ok, and the brain gave this token rc and stable) goes to rc and
/// stable with edge, the same objects — the maintainer decided the build,
/// the evidence decides the speed. Recorded as a fast-track.
fn fast_lane(
    opts: &WorkOptions,
    job: &Api,
    task: &Task,
    built: i64,
    pkgs: &[PathBuf],
    manifest: &pkg_manifest::PackageManifest,
    rendered: &mut Vec<String>,
) -> Result<Vec<String>> {
    let shas: Vec<String> = pkgs
        .iter()
        .filter_map(|p| pkg_extract::extract_manifest(p).ok().map(|m| m.sha256))
        .collect();
    let mut fast = Vec::new();
    for ring in ["rc", "stable"] {
        let created = job.create_release(&ReleaseRequest {
            ring,
            add: &shas,
            remove_arch: Some(&task.arch),
            note: Some(&format!(
                "fast-track: factory task {built}, {} {} — approved, the trial installed it",
                manifest.name, manifest.version
            )),
            ..ReleaseRequest::default()
        })?;
        rendered.extend(ops::render(job, ring, &task.arch, opts.sign.as_deref())?);
        fast.push(format!("{ring}#{}", created.release.seq));
    }
    job.post_event(&serde_json::json!({
        "kind": "fast-track", "ring": "stable", "source": "factory", "status": "ok",
        "summary": format!("{} {} fast-tracked to rc and stable for {}: approved by {}, installed by the trial", manifest.name, manifest.version, task.arch, s(&task.params, "by")),
        "payload": { "task": built, "name": manifest.name, "version": manifest.version, "sha256": manifest.sha256, "arch": task.arch, "releases": fast, "by": s(&task.params, "by") },
    }))?;
    Ok(fast)
}

/// The trial of the project's review build: its packages from staging into
/// the pool under the factory's directory and pinned into the lab (never a
/// promised ring), the lab rendered, then a real pacman in a clean
/// container installs them from the lab above edge (tests/trial.sh) —
/// hooks run, files verified — and the transcript goes beside the build's
/// other evidence (trial.log) for the maintainer who decides. The same
/// objects reach edge later by the publish job, already in the pool.
fn trial_job(
    opts: &WorkOptions,
    job: &Api,
    task: &Task,
    token: &Arc<Mutex<String>>,
) -> Result<Outcome> {
    let built = task
        .params
        .get("task")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| anyhow!("trial: params.task names the project's build"))?;
    let files: Vec<String> = task
        .params
        .get("files")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    anyhow::ensure!(
        !files.is_empty(),
        "trial: params.files lists the staged packages"
    );
    let dir = opts.work_dir.join(format!("trial-{}", task.id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let mut pkgs = Vec::new();
    for f in &files {
        anyhow::ensure!(
            f.ends_with(".pkg.tar.zst") && !f.contains('/'),
            "trial: {f} is not a package file name"
        );
        let dest = dir.join(f);
        job.download_as_self(
            &format!("{}/api/v1/factory/tasks/{built}/artifacts/{f}", job.base()),
            &dest,
        )
        .with_context(|| format!("fetching {f} of the project's build {built}"))?;
        pkgs.push(dest);
    }
    pkgs.sort();
    let names: Vec<String> = pkgs
        .iter()
        .filter_map(|p| pkg_extract::extract_manifest(p).ok().map(|m| m.name))
        .collect();
    anyhow::ensure!(!names.is_empty(), "trial: no package could be read");
    ops::publish(
        job,
        "lab",
        "factory",
        &task.arch,
        Some(&format!(
            "trial of factory task {built}: {} — into the lab, not promised",
            task.name
        )),
        &pkgs,
    )?;
    let rendered = ops::render(job, "lab", &task.arch, opts.sign.as_deref())?;
    let _ = std::fs::remove_dir_all(&dir);
    let log = opts.work_dir.join("tmp").join(format!("trial-{built}.log"));
    let mut args: Vec<&str> = vec![&task.arch];
    let built_s = built.to_string();
    args.push(&built_s);
    args.extend(names.iter().map(String::as_str));
    let ok = script(opts, token, "tests/trial.sh", &args)?;
    let transcript = std::fs::read(&log).unwrap_or_default();
    if !transcript.is_empty() {
        job.put_bytes(
            &format!("/factory/tasks/{built}/artifacts/trial.log"),
            &transcript,
        )
        .with_context(|| format!("attaching trial.log to staged task {built}"))?;
    }
    let _ = std::fs::remove_file(&log);
    let verdict = String::from_utf8_lossy(&transcript)
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix("TRIAL="))
        .unwrap_or(if ok { "ok" } else { "failed" })
        .to_owned();
    let result = serde_json::json!({ "verdict": verdict, "packages": names, "task": built, "rendered": rendered });
    if ok {
        Ok(Outcome {
            summary: format!(
                "trial of {} ({}): installed from the lab above edge on {}, hooks ran, files verified",
                task.name,
                names.join(", "),
                task.arch
            ),
            result,
        })
    } else {
        // A failed trial is a verdict, not a broken job: the task completes
        // with it so the Review page shows it; the transcript says why.
        Ok(Outcome {
            summary: format!(
                "trial of {} ({}) on {}: {verdict} — see trial.log",
                task.name,
                names.join(", "),
                task.arch
            ),
            result,
        })
    }
}

/// The keyrings a sync task names: one per source of the batch, or the single source's.
fn task_keyrings(task: &Task, batch: &[serde_json::Value]) -> Vec<String> {
    let names = if batch.is_empty() {
        vec![s(&task.params, "keyring")]
    } else {
        batch.iter().map(|p| s(p, "keyring")).collect()
    };
    names.into_iter().filter(|k| !k.is_empty()).collect()
}

fn sync_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let batch: Vec<serde_json::Value> = task
        .params
        .get("sources")
        .and_then(serde_json::Value::as_str)
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    let keys = keyrings_for(opts, &task_keyrings(task, &batch))?;
    if batch.is_empty() {
        let o = sync_options(opts, &task.params, &keys, false);
        let report = ops::run_sync_report(job, &o)?;
        let rendered = if report.release.is_some() {
            render_both(opts, job, &o.ring, &o.arch, &report.unchanged_arches)?
        } else {
            Vec::new()
        };
        return Ok(Outcome {
            summary: format!(
                "{}/{} → {}: upstream {}, uploaded {}, removed {}, failed {}{}",
                o.source,
                o.arch,
                o.ring,
                report.upstream_total,
                report.uploaded,
                report.removed,
                report.failed.len(),
                if rendered.is_empty() {
                    String::new()
                } else {
                    format!("; rendered {}", rendered.join(", "))
                }
            ),
            result: serde_json::json!({ "upstream_total": report.upstream_total, "uploaded": report.uploaded, "already_indexed": report.already_indexed, "removed": report.removed, "deferred": report.deferred, "failed": report.failed.len(), "release": report.release, "rendered": rendered }),
        });
    }

    // Per ring: what to pin, what to drop, and the note's pieces.
    let mut pending: BTreeMap<String, Pending> = BTreeMap::new();
    let mut lines = Vec::new();
    let mut per_source = Vec::new();
    let mut arch = String::new();
    for p in &batch {
        let o = sync_options(opts, p, &keys, true);
        arch.clone_from(&o.arch);
        let report = match ops::run_sync_report(job, &o) {
            Ok(r) => r,
            Err(e) => {
                // One source failing (a mirror down) must not stop the others;
                // its own sync event says what happened.
                lines.push(format!("{}: failed ({e:#})", o.source));
                per_source.push(serde_json::json!({ "source": o.source, "ring": o.ring, "error": format!("{e:#}") }));
                continue;
            }
        };
        lines.push(format!(
            "{}: +{} -{} of {}",
            o.source, report.uploaded, report.removed, report.upstream_total
        ));
        per_source.push(serde_json::json!({ "source": o.source, "ring": o.ring, "upstream_total": report.upstream_total, "uploaded": report.uploaded, "removed": report.removed, "failed": report.failed.len() }));
        if !report.pending_add.is_empty() || !report.pending_remove.is_empty() {
            let e = pending.entry(o.ring.clone()).or_default();
            e.add.extend(report.pending_add);
            e.remove.extend(report.pending_remove);
            e.notes.push(format!(
                "{} +{} -{}",
                o.source, report.uploaded, report.removed
            ));
        }
    }
    let mut releases = Vec::new();
    let mut rendered = Vec::new();
    for (ring, p) in &pending {
        let note = format!("sync {arch}: {}", p.notes.join(", "));
        let created = job.create_release(&ReleaseRequest {
            ring,
            add: &p.add,
            remove_from: &p.remove,
            remove_arch: Some(&arch),
            note: Some(&note),
            ..ReleaseRequest::default()
        })?;
        releases.push(serde_json::json!({ "ring": ring, "id": created.release.id, "seq": created.release.seq, "packages": created.package_count, "unchanged": created.unchanged_arches }));
        rendered.extend(render_both(
            opts,
            job,
            ring,
            &arch,
            &created.unchanged_arches,
        )?);
    }
    Ok(Outcome {
        summary: format!(
            "{arch}: {}; {} release(s){}",
            lines.join(", "),
            releases.len(),
            if rendered.is_empty() {
                String::new()
            } else {
                format!("; rendered {}", rendered.join(", "))
            }
        ),
        result: serde_json::json!({ "arch": arch, "sources": per_source, "releases": releases, "rendered": rendered }),
    })
}

/// Runs one of the pipeline's scripts with the job's credential; true when it exited 0.
fn script(
    opts: &WorkOptions,
    token: &Arc<Mutex<String>>,
    rel: &str,
    args: &[&str],
) -> Result<bool> {
    let repo = repo_dir(opts)?;
    let exe = std::env::current_exe()?;
    let bin = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    // The scripts start containers that mount their scratch directory
    // (`mktemp -d`): under the work directory, which is the same path on
    // the host when this worker is itself a container (docs: /docs/workers),
    // rather than a /tmp the runtime on the host cannot see.
    let tmp = opts.work_dir.join("tmp");
    std::fs::create_dir_all(&tmp)?;
    let status = Command::new("bash")
        .arg(repo.join(rel))
        .args(args)
        .env("OMARCHY_API", &opts.api)
        .env("OMARCHY_POOL", &opts.pool)
        .env("OMARCHY_TOKEN", token.lock().unwrap().clone())
        .env("PKG_REPO", &exe)
        .env("OMARCHY_KEYRINGS", opts.work_dir.join("keyrings"))
        .env("OMARCHY_WORK_DIR", &opts.work_dir)
        .env("OMARCHY_CLI", bin.join("omarchy-cli"))
        .env("PKG_EXTRACT", bin.join("pkg-extract"))
        .env("TMPDIR", &tmp)
        .current_dir(&repo)
        .status()
        .with_context(|| format!("running {rel}"))?;
    Ok(status.success())
}

/// A rollback: the ring pointed at an earlier release — all of it, or one
/// architecture — then rendered where it changed.
fn rollback_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let ring = s(&task.params, "ring");
    let to = task
        .params
        .get("to")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|x| x.parse().ok()))
        })
        .ok_or_else(|| anyhow!("rollback needs `to`, a release id"))?;
    let note = s(&task.params, "note");
    let only = s(&task.params, "arch");
    let created = ops::rollback(
        job,
        &ring,
        to,
        if note.is_empty() { None } else { Some(&note) },
        if only.is_empty() { None } else { Some(&only) },
    )?;
    // One architecture rolled back: the other's databases are as they were.
    let keep: Vec<String> = if only.is_empty() {
        Vec::new()
    } else {
        ["x86_64", "aarch64"]
            .iter()
            .filter(|a| **a != only)
            .map(|a| (*a).to_owned())
            .collect()
    };
    let rendered = render_both(opts, job, &ring, &opts.arch, &keep)?;
    Ok(Outcome {
        summary: format!(
            "{ring} rolled back to release {to} as release {created}; rendered {}",
            rendered.join(", ")
        ),
        result: serde_json::json!({ "ring": ring, "to": to, "release_id": created, "rendered": rendered }),
    })
}

/// Does what the pool serves verify? Every OPR object of every ring and
/// architecture, downloaded and checked against Omarchy's keyring; what is
/// wrong is repaired (`verify.rs`) and the rings re-pinned are rendered.
/// The one-time move of every object into its source's directory
/// (`<source>/<arch>/<filename>`, routes/relayout.ts): copy until nothing
/// remains, render every ring so its databases sit in the same directories
/// (the include then names them), and purge the flat directories last. The
/// pool does the copying; this loops, a page at a time, and renders. Hours
/// of pages: every call takes the token the heartbeat last renewed — a
/// per-job token lives thirty minutes, and the first run died on a 401
/// with the token it started with (task 275, 2026-09-15).
fn relayout_job(opts: &WorkOptions, token: &Arc<Mutex<String>>) -> Result<Outcome> {
    let started = Instant::now();
    let fresh = || Api::new(&opts.api, &token.lock().unwrap().clone());
    let (mut moved, mut ghosts, mut missing) = (0u64, 0u64, 0u64);
    let mut errors: Vec<String> = Vec::new();
    loop {
        let r = fresh()?.relayout("copy", 40)?;
        let step = r["moved"].as_u64().unwrap_or(0) + r["ghosts"].as_u64().unwrap_or(0);
        moved += r["moved"].as_u64().unwrap_or(0);
        ghosts += r["ghosts"].as_u64().unwrap_or(0);
        missing += r["missing"].as_u64().unwrap_or(0);
        if let Some(e) = r["errors"].as_array() {
            errors.extend(e.iter().filter_map(|v| v.as_str().map(str::to_owned)));
        }
        let remaining = r["remaining"].as_u64().unwrap_or(0);
        tracing::info!(moved, ghosts, missing, remaining, "relayout: copying");
        if remaining == 0 {
            break;
        }
        if step == 0 {
            // Nothing moved in a whole page: what is left cannot be copied
            // (an object missing from the pool, a storage error) — the
            // flat directory stays, the include keeps naming it, and the
            // rows say which.
            return Err(anyhow!(
                "relayout stalled with {remaining} object(s) left: {missing} missing, {} error(s){}",
                errors.len(),
                errors.first().map(|e| format!(" — {e}")).unwrap_or_default()
            ));
        }
    }
    let mut rendered = Vec::new();
    for ring in ["edge", "rc", "stable"] {
        for arch in ["x86_64", "aarch64"] {
            let repos = ops::render(&fresh()?, ring, arch, opts.sign.as_deref())
                .with_context(|| format!("rendering {ring}/{arch} after the move"))?;
            rendered.extend(repos.into_iter().map(|r| format!("{ring}/{arch}/{r}")));
        }
    }
    let mut deleted = 0u64;
    loop {
        let r = fresh()?.relayout("purge", 40)?;
        deleted += r["deleted"].as_u64().unwrap_or(0);
        if !r["truncated"].as_bool().unwrap_or(false) {
            break;
        }
    }
    let summary = format!(
        "relayout: {moved} object(s) moved into their source's directory, {ghosts} ghost row(s) marked, {} database(s) rendered, {deleted} old key(s) purged",
        rendered.len()
    );
    fresh()?.post_event(&serde_json::json!({
        "kind": "relayout", "status": if errors.is_empty() && missing == 0 { "ok" } else { "warn" },
        "summary": summary,
        "duration_ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "payload": { "moved": moved, "ghosts": ghosts, "missing": missing, "errors": errors, "rendered": rendered, "purged": deleted },
    }))?;
    Ok(Outcome {
        summary,
        result: serde_json::json!({ "moved": moved, "ghosts": ghosts, "missing": missing, "errors": errors, "rendered": rendered, "purged": deleted }),
    })
}

fn verify_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let keys = keyrings(opts)?;
    let ring = s(&task.params, "ring");
    let arch = s(&task.params, "arch");
    let report = crate::verify::run(
        job,
        &crate::verify::VerifyOptions {
            pool: opts.pool.clone(),
            rings: if ring.is_empty() {
                vec!["edge".into(), "rc".into(), "stable".into()]
            } else {
                vec![ring]
            },
            arches: if arch.is_empty() {
                vec!["x86_64".into(), "aarch64".into()]
            } else {
                vec![arch]
            },
            keyring: keys.join("omarchy.gpg"),
            work_dir: opts.work_dir.clone(),
            repair: s(&task.params, "repair") != "no",
        },
    )?;
    let mut rendered = Vec::new();
    for (ring, arch) in &report.repinned_rings {
        rendered.extend(ops::render(job, ring, arch, opts.sign.as_deref())?);
    }
    for d in &report.details {
        eprintln!("  {d}");
    }
    job.post_event(&serde_json::json!({
        "kind": "verify", "status": if report.clean() { "ok" } else if report.unfixable > 0 { "error" } else { "warn" },
        "summary": report.summary(),
        "payload": { "objects": report.objects, "bad_signatures": report.bad_signatures, "repaired_signatures": report.repaired_signatures,
                     "mismatched": report.mismatched, "repinned": report.repinned, "unfixable": report.unfixable, "rendered": rendered,
                     "details": report.details.iter().take(60).collect::<Vec<_>>() },
    }))?;
    Ok(Outcome {
        summary: format!(
            "{}{}",
            report.summary(),
            if rendered.is_empty() {
                String::new()
            } else {
                format!("; rendered {}", rendered.join(", "))
            }
        ),
        result: serde_json::to_value(&report)?,
    })
}

/// A project build: the PKGBUILD (from the repository, a contributor's
/// repository, a draft, or a staged build a maintainer approved) built in a
/// fresh Arch container by the pipeline's own script, then signed,
/// published into edge as source `factory` and rendered — by this worker,
/// with the job's credential. Community builds stay with the container
/// image (`omarchy-build-worker --container`); this executor takes only
/// tasks a project-trusted worker may claim.
#[allow(clippy::too_many_lines)]
fn build_job(opts: &WorkOptions, task: &Task, token: &Arc<Mutex<String>>) -> Result<Outcome> {
    anyhow::ensure!(
        task.trust == "project",
        "community builds run in the Omarchy Packaging image, not here"
    );
    let repo = repo_dir(opts)?;
    let dir = opts.work_dir.join(format!("task-{}", task.id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("out"))?;
    let pkgbuild_ref = task.pkgbuild_ref.clone();
    // Inside the container "localhost" is the container: a local pool (wrangler
    // dev) is reached through the runtime's host alias.
    let from_container = |u: &str| {
        u.replace("://localhost", "://host.containers.internal")
            .replace("://127.0.0.1", "://host.containers.internal")
    };
    // The project's review build (review:<task>, params.review): the
    // request's facts ride along for the drafter, and the result is staged
    // for a maintainer instead of published.
    let review = task
        .params
        .get("review")
        .and_then(serde_json::Value::as_i64);
    let mut meta = format!(
        "name={}\nref={}\narch={}\npool={}\nexport OMARCHY_API={}\n",
        shell_quote(&task.name),
        shell_quote(&pkgbuild_ref),
        shell_quote(&task.arch),
        shell_quote(&from_container(&opts.pool)),
        shell_quote(&from_container(&opts.api))
    );
    if review.is_some() {
        for (var, key) in [
            ("review_url", "project"),
            ("review_source", "source"),
            ("review_version", "version"),
            ("review_desc", "description"),
            ("review_license", "license"),
        ] {
            let v = s(&task.params, key);
            if !v.is_empty() {
                use std::fmt::Write as _;
                let _ = writeln!(meta, "{var}={}", shell_quote(&v));
            }
        }
    }
    // What the asker put with the build, for the drafter: a build to learn
    // from (its PKGBUILD and log) and a word from the person who asked.
    for (var, key) in [("lesson", "lesson"), ("hint", "hint")] {
        let v = match task.params.get(key) {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => s(&task.params, key),
        };
        if !v.is_empty() {
            use std::fmt::Write as _;
            let _ = writeln!(meta, "{var}={}", shell_quote(&v));
        }
    }
    std::fs::write(dir.join("meta.sh"), meta)?;
    std::fs::copy(
        repo.join("factory/worker/omarchy-build-worker.sh"),
        dir.join("worker.sh"),
    )?;
    let runtime = ["podman", "docker"]
        .iter()
        .find(|r| Command::new(r).arg("--version").output().is_ok())
        .ok_or_else(|| anyhow!("podman or docker is required"))?;
    let (image, platform) = if task.arch == "aarch64" {
        ("docker.io/menci/archlinuxarm:base-devel", "linux/arm64")
    } else {
        ("docker.io/library/archlinux:base-devel", "linux/amd64")
    };
    let log = std::fs::File::create(dir.join("build.log"))?;
    let mut run = Command::new(runtime);
    run.args([
        "run",
        "--rm",
        "--platform",
        platform,
        "--name",
        &format!("omarchy-build-{}", task.id),
        "-v",
    ])
    .arg(format!("{}:/task", dir.display()));
    // The release's own checkout — the drafter, the auditor's tooling, the
    // prompts, the skills, the pool's key — rides into the plain Arch
    // container read-only, so a build clones nothing: builds go on when
    // GitHub does not answer (2026-09-17), and the script and its tooling
    // are always the same release.
    run.arg("-v")
        .arg(format!("{}:/pool:ro", repo.display()))
        .arg("-e")
        .arg("OMARCHY_FACTORY_LIB=/pool/factory");
    // What the operator hands every build container: the agent's address
    // (OMARCHY_BUILD_ENV, comma-separated KEY=VALUE — the agent-proxy on the
    // Studio, where Claude Code cannot run under qemu) and the network it
    // is on (OMARCHY_BUILD_NETWORK). A review build needs an agent inside.
    if let Ok(envs) = std::env::var("OMARCHY_BUILD_ENV") {
        for kv in envs.split(',').map(str::trim).filter(|kv| kv.contains('=')) {
            run.arg("-e").arg(kv);
        }
    }
    // The worker's labels ride along: an emulated worker's build container
    // probes the toolchains a recipe installs (omarchy-build-worker.sh,
    // toolchains_start, libraries_start) and fails at once when one cannot
    // start. The labels this worker claimed with (`--labels`, or
    // WORKER_LABELS), not the environment's own: what the container
    // probes, what this worker reports and what the pool heeds are one.
    run.arg("-e").arg(format!("WORKER_LABELS={}", opts.labels));
    if let Ok(net) = std::env::var("OMARCHY_BUILD_NETWORK") {
        if !net.is_empty() {
            run.arg("--network").arg(net);
        }
    }
    // No GITHUB_TOKEN in there: the drafter reads GitHub through the broker
    // (GITHUB_API in OMARCHY_BUILD_ENV, factory/bin/broker) — the build
    // container is born with nothing (/docs/security-model, *Isolation*).
    // A package cache shared by every build container on this host
    // (OMARCHY_PKG_CACHE, one directory per architecture): pacman downloads
    // a dependency once, not once per build.
    if let Some(cache) = pkg_cache_dir(&task.arch)? {
        run.arg("-v")
            .arg(format!("{}:/var/cache/pacman/pkg", cache.display()));
    }
    // Build caches that outlive the container (OMARCHY_BUILD_CACHE): cargo's
    // registry, Go's module and build caches, ccache — a Rust or Go package
    // rebuilds in minutes, not tens. Under `project/<arch>`: what the
    // project's builds write, only the project's builds read — a community
    // container on the same host mounts `community/<arch>` (factory/host/
    // compose.yml) — and inside, the script keeps one directory per package.
    if let Some(cache) = cache_dir("OMARCHY_BUILD_CACHE", &format!("project/{}", task.arch))? {
        run.arg("-v")
            .arg(format!("{}:/build/cache", cache.display()));
    }
    let status = run
        .args([image, "bash", "/task/worker.sh", "--inside"])
        .stdout(log.try_clone()?)
        .stderr(log)
        .status()
        .context("running the build container")?;
    // The pool is spoken to only now, with the token the heartbeat last
    // renewed: the one the claim issued lives thirty minutes, and a build
    // is often longer — the lesson relayout learned on task 275.
    let renewed = Api::new(&opts.api, &token.lock().unwrap().clone())?;
    let job = &renewed;
    let log_text = std::fs::read_to_string(dir.join("build.log")).unwrap_or_default();
    if !status.success() {
        let tail: String = log_text
            .lines()
            .rev()
            .take(40)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        if review.is_some() {
            // What there is goes on the record: the log, the gate's verdict, the recipe that failed.
            stage_evidence(
                job,
                task.id,
                &dir,
                &["build.log"],
                &["PKGBUILD", "vet.json", "tests.log", "resources.json"],
            );
        }
        // Died of emulation: this worker's failure, not the recipe's — back
        // to the queue for a native worker (report, `needs_native`).
        if let Some(why) = emulation_failure(emulated(&opts.labels), status.code(), &log_text) {
            return Err(NeedsNative(format!(
                "build failed (exit {:?}) — this worker's, not the recipe's: {why}:\n{tail}",
                status.code()
            ))
            .into());
        }
        let gate = status.code() == Some(5);
        return Err(anyhow!(
            "build failed (exit {:?}){}:\n{tail}",
            status.code(),
            if gate { " — the gate" } else { "" }
        ));
    }
    let mut pkgs: Vec<PathBuf> = std::fs::read_dir(dir.join("out"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".pkg.tar.zst"))
        .collect();
    pkgs.sort();
    anyhow::ensure!(!pkgs.is_empty(), "makepkg produced no package");
    if let Some(from) = review {
        // The project's review build: everything to staging for a
        // maintainer — the packages, the recipe, the log, the manifest, the
        // gate — nothing to the pool until the approval's publish job.
        let main = pkgs
            .iter()
            .find(|p| {
                p.file_name()
                    .is_some_and(|f| f.to_string_lossy().starts_with(&format!("{}-", task.name)))
            })
            .unwrap_or(&pkgs[0]);
        let manifest = pkg_extract::extract_manifest(main)?;
        let pkginfo = Command::new("tar")
            .arg("-xOf")
            .arg(main)
            .arg(".PKGINFO")
            .output()
            .map(|o| o.stdout)
            .unwrap_or_default();
        // Streamed from disk, in parts above 90 MB: an Electron app is a
        // 144 MB package, and a single body that size never reaches the
        // pool (the edge answers 413 first).
        for p in &pkgs {
            let name = p
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default();
            job.stage_file(task.id, &name, p)
                .with_context(|| format!("staging {name}"))?;
        }
        if !pkginfo.is_empty() {
            job.put_bytes(
                &format!("/factory/tasks/{}/artifacts/PKGINFO", task.id),
                &pkginfo,
            )
            .context("staging PKGINFO")?;
        }
        stage_evidence(
            job,
            task.id,
            &dir,
            &["build.log"],
            &["PKGBUILD", "vet.json", "tests.log", "resources.json"],
        );
        let _ = std::fs::remove_dir_all(&dir);
        return Ok(Outcome {
            summary: format!(
                "{} {} built by the project for {} from staged task {from} — staged for a maintainer's approval",
                manifest.name, manifest.version, task.arch
            ),
            result: serde_json::json!({ "sha256": manifest.sha256, "filename": manifest.filename, "version": manifest.version, "review": from }),
        });
    }
    // The pool signs what it stores (/docs/security-model); a local key only covers
    // a pool that has none.
    if let Some(key) = &opts.sign {
        if !job.signing()? {
            for p in &pkgs {
                crate::sign::detach_sign(p, key)?;
            }
        }
    }
    ops::publish(
        job,
        "edge",
        "factory",
        &task.arch,
        Some(&format!(
            "factory task {}: {} ({})",
            task.id, task.name, pkgbuild_ref
        )),
        &pkgs,
    )?;
    // A release covers both architectures: render both so the head is
    // complete (the other architecture's databases do not change content).
    let mut rendered = ops::render(job, "edge", &task.arch, opts.sign.as_deref())?;
    let other = if task.arch == "aarch64" {
        "x86_64"
    } else {
        "aarch64"
    };
    rendered.extend(ops::render(job, "edge", other, opts.sign.as_deref())?);
    let main = pkgs
        .iter()
        .find(|p| {
            p.file_name()
                .is_some_and(|f| f.to_string_lossy().starts_with(&format!("{}-", task.name)))
        })
        .unwrap_or(&pkgs[0]);
    let manifest = pkg_extract::extract_manifest(main)?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(Outcome {
        summary: format!(
            "{} {} built for {} and published into edge ({})",
            manifest.name,
            manifest.version,
            task.arch,
            rendered.join(", ")
        ),
        result: serde_json::json!({ "sha256": manifest.sha256, "filename": manifest.filename, "version": manifest.version, "rendered": rendered }),
    })
}

/// The second agent: reads the evidence a contributor staged (PKGBUILD,
/// build log, .PKGINFO — the public part of the staging workspace), asks
/// the model for a structured review with `factory/bin/audit-pkgbuild`
/// (the owner's agent key, from this process's environment; any provider
/// `factory/bin/agent.py` knows) and
/// attaches `audit.json` and `audit.md` to the same evidence with the job's
/// credential. The maintainer reads it; nothing here decides anything.
fn audit_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    anyhow::ensure!(
        agent_label().is_some(),
        "no agent key on this worker (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY or XAI_API_KEY); start it without the audit kind"
    );
    let staged = task
        .params
        .get("task")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|x| x.parse().ok()))
        })
        .ok_or_else(|| anyhow!("audit needs `task`, the staged build's id"))?;
    let repo = repo_dir(opts)?;
    let dir = opts.work_dir.join(format!("audit-{}", task.id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let evidence = format!("{}/api/v1/factory/tasks/{staged}/artifacts", job.base());
    for name in ["PKGBUILD", "build.log"] {
        job.download(&format!("{evidence}/{name}"), &dir.join(name))
            .with_context(|| format!("fetching {name} of staged task {staged}"))?;
    }
    let pkginfo = dir.join("PKGINFO");
    let has_pkginfo = job
        .download(&format!("{evidence}/PKGINFO"), &pkginfo)
        .is_ok();
    // The gate's transcript, when the build ran one (workers before the gate did not).
    let tests = dir.join("tests.log");
    let has_tests = job
        .download(&format!("{evidence}/tests.log"), &tests)
        .is_ok();
    let mut cmd = Command::new("python3");
    cmd.arg(repo.join("factory/bin/audit-pkgbuild"))
        .arg("--pkgbuild")
        .arg(dir.join("PKGBUILD"))
        .arg("--log")
        .arg(dir.join("build.log"))
        .arg("--out")
        .arg(&dir);
    if has_pkginfo {
        cmd.arg("--pkginfo").arg(&pkginfo);
    }
    if has_tests {
        cmd.arg("--tests").arg(&tests);
    }
    let out = cmd.output().context("running audit-pkgbuild")?;
    if !out.status.success() {
        return Err(anyhow!(
            "the audit produced no report (exit {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let report: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("audit.json"))?).context("audit.json")?;
    for name in ["audit.json", "audit.md"] {
        job.put_bytes(
            &format!("/factory/tasks/{staged}/artifacts/{name}"),
            &std::fs::read(dir.join(name))?,
        )
        .with_context(|| format!("attaching {name} to staged task {staged}"))?;
    }
    let _ = std::fs::remove_dir_all(&dir);
    let verdict = s(&report, "verdict");
    let findings = report
        .get("findings")
        .and_then(|f| f.as_array())
        .map_or(0, Vec::len);
    Ok(Outcome {
        summary: format!(
            "{verdict}: {} ({findings} finding(s), {})",
            s(&report, "summary"),
            s(&report, "model")
        ),
        result: report,
    })
}

/// How long a health or ABI check counts as evidence (gate.rs).
const ABI_MAX_AGE_HOURS: u32 = 24;

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The daily promotion, as the pipeline does it: evidence on both
/// architectures, the gate, the promotion, both databases rendered, health
/// of the new head — and a rollback when health fails.
#[allow(clippy::too_many_lines)]
fn promote_job(
    opts: &WorkOptions,
    job: &Api,
    task: &Task,
    token: &Arc<Mutex<String>>,
) -> Result<Outcome> {
    let from = s(&task.params, "from");
    let to = s(&task.params, "to");
    let note = s(&task.params, "note");
    // The soak, in green health checks of `from` since its current release:
    // one for edge → rc (the check this job runs), two for rc → stable (the
    // one before, three hours earlier, and this one) unless the task says.
    let soak_checks = u32::try_from(
        task.params
            .get("soak_checks")
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|x| x.parse().ok()))
            })
            .unwrap_or(if to == "stable" { 2 } else { 1 }),
    )
    .unwrap_or(1);
    // One architecture only (`arch`): its evidence, its gate, its rows, its
    // databases, its health — the other keeps what `to` serves today.
    let only = s(&task.params, "arch");
    let arches: Vec<String> = if only.is_empty() {
        vec!["x86_64".to_owned(), "aarch64".to_owned()]
    } else {
        vec![only.clone()]
    };
    let only_arch = if only.is_empty() {
        None
    } else {
        Some(only.as_str())
    };
    // `force` (a maintainer's emergency, queued by hand) skips the evidence
    // and the gate; the health check of the target still runs and still
    // rolls back.
    let forced = s(&task.params, "force") == "yes";
    if !forced {
        // Evidence: health and ABI of the source ring, both architectures. The
        // scripts record events; the gate reads them. Failures are evidence too.
        // The health check is the soak and runs every time; the ABI verdict of
        // an unchanged release stands (gate.rs) and is not paid for again.
        for arch in &arches {
            let _ = script(opts, token, "tests/health-check.sh", &[&from, arch]);
            if gate::abi_evidence_stands(job, &from, arch, ABI_MAX_AGE_HOURS).unwrap_or(false) {
                eprintln!("abi: {from} {arch}: the current release's verdict stands, not repeated");
            } else {
                let _ = script(opts, token, "tests/abi-gate.sh", &[&from, arch]);
            }
        }
    }
    let report = if forced {
        gate::GateReport {
            verdict: Verdict::Promote,
            evidence: Vec::new(),
        }
    } else {
        gate::run(
            job,
            &GateOptions {
                from: &from,
                to: &to,
                arches: &arches,
                soak_checks,
                max_age_hours: ABI_MAX_AGE_HOURS,
                dry_run: false,
            },
        )?
    };
    match report.verdict {
        Verdict::Skip(why) => {
            return Ok(Outcome {
                summary: format!("{from} → {to}: nothing to promote ({why})"),
                result: serde_json::json!({ "verdict": "skip", "why": why }),
            })
        }
        Verdict::Block(reasons) => {
            return Ok(Outcome {
                summary: format!("{from} → {to}: blocked — {}", reasons.join("; ")),
                result: serde_json::json!({ "verdict": "blocked", "reasons": reasons }),
            })
        }
        Verdict::Promote => {}
    }
    let previous = ops::head(job, &to)?;
    let created = ops::promote(job, &from, &to, Some(&note), only_arch)?;
    // What the promotion wrote is what the ring serves: no source, the OPR
    // included, reaches rc or stable on its name — its rc and stable
    // channels were once synced in here after every promotion, the one
    // source that skipped the gates, and rc#43 removed thirteen names the
    // gate had just promoted (zero trust, 2026-09-16; the loop went 2026-09-18).
    let mut rendered = Vec::new();
    for arch in &arches {
        rendered.extend(ops::render(job, &to, arch, opts.sign.as_deref())?);
    }
    let mut unhealthy = Vec::new();
    for arch in &arches {
        if !script(opts, token, "tests/health-check.sh", &[&to, arch])? {
            unhealthy.push(arch.clone());
        }
    }
    if unhealthy.is_empty() {
        job.post_event(&serde_json::json!({ "kind": "promote", "ring": to, "source": from, "status": "ok",
            "summary": format!("{to} serves release {} (from {from}); health ok on {}", created, arches.join(" and ")),
            "payload": { "release_id": created, "note": note } }))?;
        return Ok(Outcome {
            summary: format!("{from} → {to}: release {created}, healthy on both architectures"),
            result: serde_json::json!({ "verdict": "promoted", "release_id": created, "rendered": rendered }),
        });
    }
    match previous {
        Some(prev) => {
            ops::rollback(
                job,
                &to,
                prev,
                Some(&format!(
                    "automatic rollback: health failed after promotion from {from} ({})",
                    unhealthy.join(", ")
                )),
                only_arch,
            )?;
            for arch in &arches {
                ops::render(job, &to, arch, opts.sign.as_deref())?;
            }
            job.post_event(&serde_json::json!({ "kind": "rollback", "ring": to, "source": from, "status": "error",
                "summary": format!("{to} rolled back to release {prev}: health failed on {} after promotion from {from}", unhealthy.join(", ")),
                "payload": { "release_id": created, "rolled_back_to": prev, "unhealthy": unhealthy } }))?;
            Ok(Outcome {
                summary: format!(
                    "{from} → {to}: rolled back to {prev} (health failed on {})",
                    unhealthy.join(", ")
                ),
                result: serde_json::json!({ "verdict": "rolled-back", "release_id": created, "to": prev, "unhealthy": unhealthy }),
            })
        }
        None => Err(anyhow!(
            "health failed on {} after promotion and {to} had no previous release to roll back to",
            unhealthy.join(", ")
        )),
    }
}

/// The public vulnerability feeds the security layer reads (/docs/security-model).
const FEEDS: [(&str, &str); 4] = [
    (
        "arch.json",
        "https://security.archlinux.org/issues/all.json",
    ),
    (
        "debian.json",
        "https://security-tracker.debian.org/tracker/data/json",
    ),
    (
        "kev.json",
        "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    ),
    (
        "epss.csv.gz",
        "https://epss.cyentia.com/epss_scores-current.csv.gz",
    ),
];

/// Fetches the feeds into the work dir; returns the security options that read them.
fn fetch_feeds(opts: &WorkOptions, job: &Api) -> Result<SecurityOptions> {
    let feeds = opts.work_dir.join("feeds");
    std::fs::create_dir_all(&feeds)?;
    for (name, url) in FEEDS {
        job.download(url, &feeds.join(name))
            .with_context(|| format!("fetching {url}"))?;
    }
    let epss = feeds.join("epss.csv");
    let gz = std::fs::File::open(feeds.join("epss.csv.gz"))?;
    let mut out = std::fs::File::create(&epss)?;
    std::io::copy(&mut flate2::read::GzDecoder::new(gz), &mut out)?;
    Ok(SecurityOptions {
        arch_tracker: feeds.join("arch.json"),
        debian: Some(feeds.join("debian.json")),
        kev: Some(feeds.join("kev.json")),
        epss: Some(epss),
        osv_cache: Some(opts.work_dir.join("osv")),
        rings: vec!["edge".into(), "rc".into(), "stable".into()],
        dry_run: false,
    })
}

/// Renders a fast-tracked ring and verifies it on both architectures;
/// rolls it back to `previous` when health fails. Returns whether it was rolled back.
fn verify_fast_track(
    opts: &WorkOptions,
    job: &Api,
    token: &Arc<Mutex<String>>,
    ring: &str,
    previous: Option<u64>,
) -> Result<bool> {
    let arches = ["x86_64", "aarch64"];
    for arch in arches {
        ops::render(job, ring, arch, opts.sign.as_deref())?;
    }
    let mut unhealthy = Vec::new();
    for arch in arches {
        if !script(opts, token, "tests/health-check.sh", &[ring, arch])? {
            unhealthy.push(arch);
        }
    }
    if unhealthy.is_empty() {
        return Ok(false);
    }
    let Some(prev) = previous else {
        return Err(anyhow!(
            "health failed on {} after a fast-track into {ring}, which had no previous release to roll back to",
            unhealthy.join(", ")
        ));
    };
    ops::rollback(
        job,
        ring,
        prev,
        Some(&format!(
            "automatic rollback: health failed after a security fast-track ({})",
            unhealthy.join(", ")
        )),
        None,
    )?;
    for arch in arches {
        ops::render(job, ring, arch, opts.sign.as_deref())?;
    }
    job.post_event(&serde_json::json!({ "kind": "rollback", "ring": ring, "source": "edge", "status": "warn",
        "summary": format!("{ring}: security fast-track failed health on {}; rolled back to {prev}", unhealthy.join(", ")),
        "payload": { "restored_release_id": prev, "unhealthy": unhealthy } }))?;
    Ok(true)
}

/// The security job: fetch the feeds, match advisories against every ring,
/// then fast-track clean versions of exposed packages from edge into rc and
/// stable, render, verify on both architectures and roll back a ring whose
/// health fails — what security.yml did on GitHub, as one pulled task.
fn security_job(opts: &WorkOptions, job: &Api, token: &Arc<Mutex<String>>) -> Result<Outcome> {
    let report = security::run(job, &fetch_feeds(opts, job)?)?;
    let matched = format!(
        "{} advisories, {} vulnerable / {} fixed matches, {} in KEV",
        report.arch_advisories + report.debian_advisories,
        report.matches_vulnerable,
        report.matches_fixed,
        report.kev
    );
    // Fast-track: rc and stable take clean versions from edge, skipping the soak.
    let mut tracked = Vec::new();
    let mut rolled_back = Vec::new();
    for ring in ["rc", "stable"] {
        let previous = ops::head(job, ring)?;
        let ft = security::fast_track(
            job,
            &FastTrackOptions {
                ring,
                from: "edge",
                min_severity: "medium",
                dry_run: false,
            },
        )?;
        if ft.fixes.is_empty() {
            continue;
        }
        tracked.push(serde_json::json!({ "ring": ring, "fixes": ft.fixes.len() }));
        if verify_fast_track(opts, job, token, ring, previous)? {
            rolled_back.push(ring);
        }
    }
    let summary = if tracked.is_empty() {
        format!("{matched}; nothing to fast-track")
    } else {
        format!(
            "{matched}; fast-tracked into {}{}",
            tracked
                .iter()
                .map(|t| format!("{} ({} fix(es))", t["ring"], t["fixes"]))
                .collect::<Vec<_>>()
                .join(", "),
            if rolled_back.is_empty() {
                String::new()
            } else {
                format!("; rolled back {}", rolled_back.join(", "))
            }
        )
    };
    Ok(Outcome {
        summary,
        result: serde_json::json!({ "matches_vulnerable": report.matches_vulnerable, "matches_fixed": report.matches_fixed, "kev": report.kev,
            "fast_tracked": tracked, "rolled_back": rolled_back }),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        agent_retry_after, agent_retry_from, chrono_now, emulated, emulation_failure, fail_body,
        probe_agent, AgentCheck, AgentProbe, NeedsNative, WorkOptions, AGENT_PROBE_EVERY, POLL,
    };
    use std::time::{Duration, Instant};

    fn answer(status: &str, error: &str, at: Instant) -> AgentProbe {
        AgentProbe {
            status: status.to_owned(),
            error: error.to_owned(),
            label: if status == "ok" {
                "anthropic/claude-sonnet-5".to_owned()
            } else {
                String::new()
            },
            checked_at: Some(at),
            ms: 42,
            ..AgentProbe::default()
        }
    }

    #[test]
    fn a_failed_probe_is_tried_again_sooner_then_less_often_back_to_the_half_hour() {
        let secs: Vec<u64> = (1..=10).map(|n| agent_retry_after(n).as_secs()).collect();
        assert_eq!(secs, [15, 30, 60, 120, 240, 480, 960, 1800, 1800, 1800]);
        assert_eq!(
            agent_retry_after(u32::MAX),
            AGENT_PROBE_EVERY,
            "never overflows, never past the healthy agent's half hour"
        );
    }

    /// #277: `AGENT_RETRY_FIRST_SECONDS` only makes the backoff slower — the
    /// E2E sets it to half an hour, so the pool alone brings a worker back.
    #[test]
    fn the_first_recheck_is_a_setting_that_only_slows_the_schedule() {
        let half = Duration::from_secs(1800);
        assert!((1..=10).all(|n| agent_retry_from(half, n) == half));
        let secs: Vec<u64> = (1..=4)
            .map(|n| agent_retry_from(Duration::from_secs(60), n).as_secs())
            .collect();
        assert_eq!(secs, [60, 120, 240, 480]);
    }

    /// #277: a probe an order asked for is stored and logged like the
    /// worker's own, but a failure leaves the count alone — the worker's own
    /// backoff keeps its schedule, measured from the last probe — and an
    /// answer resets it, as always.
    #[test]
    fn an_ordered_probe_leaves_the_backoff_alone() {
        let t0 = Instant::now();
        let mut check = AgentCheck::default();
        for k in 0..3u64 {
            check.record(answer("error", "refused", t0 + Duration::from_secs(k)));
        }
        assert_eq!(check.failures, 3);
        let ordered = t0 + Duration::from_secs(10);
        check.record_ordered(answer("error", "refused", ordered));
        assert_eq!(check.failures, 3, "an ordered failure is not counted");
        assert!(!check.due(
            (ordered + agent_retry_after(3))
                .checked_sub(Duration::from_secs(1))
                .unwrap()
        ));
        assert!(check.due(ordered + agent_retry_after(3)));
        check.record_ordered(answer("ok", "", ordered + Duration::from_secs(1)));
        assert_eq!(check.failures, 0, "an answer resets it");
    }

    /// #273: the agent proxy replaced in the same rollout refuses the first
    /// probe; it listens 100 s later. The loop claims every POLL (30 s):
    /// the claims say error, then ok after the next re-check — no restart.
    #[test]
    fn an_agent_that_comes_up_late_is_reported_ok_without_a_restart() {
        let t0 = Instant::now();
        let up = t0 + Duration::from_secs(100);
        let mut check = AgentCheck::default();
        let (mut probes, mut lines, mut claims) = (Vec::new(), Vec::new(), Vec::new());
        for k in 0..60u32 {
            let now = t0 + POLL * k;
            if check.due(now) {
                probes.push((now - t0).as_secs());
                let p = if now < up {
                    answer("error", "URLError: [Errno 111] Connection refused", now)
                } else {
                    answer("ok", "", now)
                };
                lines.extend(check.record(p));
            }
            claims.push(check.probe.status.clone());
        }
        assert_eq!(claims[0], "error", "the first claim reports the refusal");
        assert_eq!(
            probes,
            [0, 30, 60, 120],
            "15 s, 30 s, 60 s at the loop's pace; then the half-hour probe"
        );
        let ok_at = claims
            .iter()
            .position(|c| c == "ok")
            .expect("ok without a restart");
        assert_eq!(ok_at, 4, "at the claim after the agent came up (+120 s)");
        assert!(claims[ok_at..].iter().all(|c| c == "ok"));
        assert_eq!(
            lines.len(),
            2,
            "once per change of state, not per check: {lines:?}"
        );
        assert!(lines[0].starts_with("agent: NOT ready — URLError: [Errno 111] Connection refused; checking again in 15 s"), "{}", lines[0]);
        assert_eq!(
            lines[1],
            "agent anthropic/claude-sonnet-5: ok (42 ms) — answering again after 3 failed check(s)"
        );
    }

    /// An agent that fails for good (no credit, a revoked key) is asked more
    /// often only at first: by the second hour it is probed every half
    /// hour, as a healthy one is — each probe is a real completion.
    #[test]
    fn an_agent_that_never_answers_backs_off_to_the_half_hour_and_is_logged_once() {
        let t0 = Instant::now();
        let mut check = AgentCheck::default();
        let (mut probes, mut lines) = (Vec::new(), 0);
        for k in 0..240u32 {
            let now = t0 + POLL * k;
            if check.due(now) {
                probes.push((now - t0).as_secs());
                lines += usize::from(check.record(answer("error", "refused", now)).is_some());
            }
        }
        let gaps: Vec<u64> = probes.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(
            gaps.windows(2).all(|g| g[1] >= g[0]),
            "never faster: {gaps:?}"
        );
        assert!(
            gaps.iter()
                .all(|&g| g <= AGENT_PROBE_EVERY.as_secs() + POLL.as_secs()),
            "never slower than the half-hour probe: {gaps:?}"
        );
        assert_eq!(
            probes,
            [0, 30, 60, 120, 240, 480, 960, 1920, 3720, 5520],
            "15 s, doubled, at the loop's 30 s pace, then every half hour"
        );
        assert_eq!(
            probes
                .iter()
                .filter(|&&t| (3600..7200).contains(&t))
                .count(),
            2,
            "the second hour: two probes, a healthy agent's rate"
        );
        assert_eq!(lines, 1, "the same error is said once");
        // A different error is news.
        assert!(check.record(answer("error", "HTTP 502", t0)).is_some());
    }

    #[test]
    fn a_healthy_agent_keeps_its_half_hour_probe() {
        let t0 = Instant::now();
        let mut check = AgentCheck::default();
        assert!(check.due(t0), "the first probe runs at once");
        assert!(check.record(answer("ok", "", t0)).is_some());
        assert!(!check.due(t0 + AGENT_PROBE_EVERY.saturating_sub(Duration::from_secs(1))));
        assert!(check.due(t0 + AGENT_PROBE_EVERY));
    }

    /// A checkout with a stub `factory/bin/agent.py` (the given Python), and
    /// the options that probe it — `None` without `timeout` or `python3`,
    /// which the image has.
    fn stub_checkout(agent_py: &str) -> Option<(tempfile::TempDir, WorkOptions)> {
        let have = |c: &str| {
            std::process::Command::new("sh")
                .args(["-c", &format!("command -v {c}")])
                .output()
                .is_ok_and(|o| o.status.success())
        };
        if !have("timeout") || !have("python3") {
            eprintln!("skipped: no timeout or python3 on this machine");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("factory/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("agent.py"), agent_py).unwrap();
        let opts = WorkOptions {
            api: String::new(),
            pool: String::new(),
            worker_token: String::new(),
            arch: "aarch64".into(),
            kinds: vec!["audit".into()],
            shared: false,
            labels: serde_json::json!({}),
            once: false,
            idle_exit: 0,
            work_dir: dir.path().into(),
            sign: None,
            repo_dir: Some(dir.path().into()),
        };
        Some((dir, opts))
    }

    /// The probe itself, against a stub `factory/bin/agent.py` in a checkout:
    /// refused until a file says the agent is up, then answered — the same
    /// check, no restart.
    #[test]
    fn the_probe_runs_the_checkouts_agent_py_and_recovers() {
        let Some((dir, opts)) = stub_checkout(
            "import json, os, sys\n\
             if os.path.exists(os.path.join(os.path.dirname(__file__), 'up')):\n    print(json.dumps({'ok': True, 'ms': 7, 'agent': 'anthropic/claude-sonnet-5'}))\n\
             else:\n    print(json.dumps({'ok': False, 'error': 'URLError: [Errno 111] Connection refused'}))\n    sys.exit(1)\n",
        ) else {
            return;
        };
        let bin = dir.path().join("factory/bin");
        let mut check = AgentCheck::default();
        check.record(probe_agent(&opts));
        assert_eq!(
            (check.probe.status.as_str(), check.probe.error.as_str()),
            ("error", "URLError: [Errno 111] Connection refused")
        );
        let at = check.probe.checked_at.unwrap();
        assert!(
            !check.due(at + Duration::from_secs(14)) && check.due(at + Duration::from_secs(15)),
            "the re-check is due after 15 s, not half an hour"
        );
        std::fs::write(bin.join("up"), "").unwrap();
        let line = check.record(probe_agent(&opts));
        assert_eq!(check.probe.status, "ok");
        assert_eq!(check.probe.label, "anthropic/claude-sonnet-5");
        assert_eq!(line.as_deref(), Some("agent anthropic/claude-sonnet-5: ok (7 ms) — answering again after 1 failed check(s)"));
    }

    /// A slow failure (agent.py waiting out a 502 from a proxy still
    /// installing Claude Code) is stamped when it ended: the next re-check
    /// is 15 s after the answer, not 15 s after the question — else the
    /// claim loop would start the next two-minute probe as soon as the last
    /// one ended (found in review).
    #[test]
    fn a_slow_probe_is_stamped_when_it_answered() {
        let Some((_dir, opts)) = stub_checkout(
            "import json, sys, time\n\
             time.sleep(1.5)\n\
             print(json.dumps({'ok': False, 'error': 'HTTP Error 502: Bad Gateway'}))\n\
             sys.exit(1)\n",
        ) else {
            return;
        };
        let asked = Instant::now();
        let mut check = AgentCheck::default();
        check.record(probe_agent(&opts));
        let answered = check.probe.checked_at.unwrap();
        assert!(
            answered >= asked + Duration::from_millis(1500),
            "stamped after the probe's 1.5 s, not before: {:?}",
            answered - asked
        );
        assert!(
            !check.due(asked + Duration::from_secs(15))
                && !check.due(answered + Duration::from_secs(14)),
            "not due 15 s after the question"
        );
        assert!(
            check.due(answered + Duration::from_secs(15)),
            "due 15 s after the answer"
        );
        assert!(!check.probe.checked_iso.is_empty());
    }

    #[test]
    fn the_probe_time_is_iso_8601_utc() {
        let now = chrono_now();
        assert_eq!(now.len(), 20, "{now}");
        assert!(now.ends_with('Z') && now.starts_with("20"), "{now}");
        // The civil-from-days arithmetic, against a date everyone knows.
        let epoch_plus = 1_700_000_000u64; // 2023-11-14T22:13:20Z
        let days = i64::try_from(epoch_plus / 86400).unwrap();
        let shifted = days + 719_468;
        let era = shifted.div_euclid(146_097);
        let day_of_era = shifted.rem_euclid(146_097);
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_index = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * month_index + 2) / 5 + 1;
        let month = if month_index < 10 {
            month_index + 3
        } else {
            month_index - 9
        };
        let year = year_of_era + era * 400 + i64::from(month <= 2);
        assert_eq!((year, month, day), (2023, 11, 14));
    }

    /// The review-x86_64 worker's own words: `{"where":…,"emulated":true}`.
    #[test]
    fn a_worker_is_emulated_when_its_labels_say_so() {
        assert!(emulated(
            &serde_json::json!({"where": "omarchy-studio", "emulated": true})
        ));
        assert!(!emulated(&serde_json::json!({"where": "omarchy-studio"})));
        assert!(!emulated(&serde_json::json!({})));
        // As the pool reads it (`!!labels.emulated`): one rule on both sides.
        for yes in [
            serde_json::json!("yes"),
            serde_json::json!("true"),
            serde_json::json!(1),
        ] {
            assert!(emulated(&serde_json::json!({ "emulated": yes })), "{yes}");
        }
        for no in [
            serde_json::json!(false),
            serde_json::json!(null),
            serde_json::json!(0),
            serde_json::json!(""),
        ] {
            assert!(!emulated(&serde_json::json!({ "emulated": no })), "{no}");
        }
    }

    /// Exit 96 is the build script's (`toolchains_start`): a toolchain that
    /// cannot start on this worker. Its line is the reason.
    #[test]
    fn exit_96_is_a_build_that_needs_a_native_worker() {
        let log = "==> Installing dependencies\n==> rustc cannot start on this worker: emulated x86_64 under qemu on a host whose page size is not the guest's — a native worker is needed for this package\n";
        assert_eq!(
            emulation_failure(true, Some(96), log).as_deref(),
            Some("rustc cannot start on this worker: emulated x86_64 under qemu on a host whose page size is not the guest's — a native worker is needed for this package")
        );
        // The status alone, whatever the labels say — the community worker's rule; the pool heeds it from an emulated worker only.
        assert_eq!(
            emulation_failure(false, Some(96), "").as_deref(),
            Some("a toolchain cannot start on this emulated worker")
        );
        // The line under another status (the container runtime's own, say), on an emulated worker.
        assert!(emulation_failure(true, Some(1), log).is_some());
    }

    /// A library qemu cannot map dies in the loader before any probe sees
    /// it: sudo through libldap, anything linking libedit. On an emulated
    /// worker that is this worker's failure; on a native one it is a real one.
    #[test]
    fn a_library_qemu_cannot_map_is_emulation_on_an_emulated_worker_only() {
        let log = "==> Starting build()...\nsudo: error while loading shared libraries: libldap.so.2: failed to map segment from shared object\n==> ERROR: A failure occurred in build().\n";
        let why = emulation_failure(true, Some(4), log).expect("emulated: this worker's");
        assert!(
            why.starts_with("sudo: error while loading shared libraries: libldap.so.2: failed to map segment from shared object — emulated under qemu"),
            "{why}"
        );
        assert!(
            why.ends_with("a native worker is needed for this package"),
            "{why}"
        );
        assert_eq!(emulation_failure(false, Some(4), log), None);
    }

    #[test]
    fn a_recipe_that_fails_is_not_emulation() {
        let log = "==> Starting build()...\nerror[E0425]: cannot find value `x` in this scope\nerror: could not compile `rusty`\n";
        assert_eq!(emulation_failure(true, Some(4), log), None);
        assert_eq!(
            emulation_failure(
                true,
                Some(5),
                "==> The gate: FAIL (1 failing check(s), 0 warning(s))\n"
            ),
            None
        );
        assert_eq!(emulation_failure(true, None, ""), None);
    }

    /// What the pool hears: `needs_native` (not final) for a build that died
    /// of emulation, final for the gate's failure, neither for the rest.
    #[test]
    fn the_fail_report_sends_needs_native_for_emulation_alone() {
        let native: anyhow::Error = NeedsNative(
            "build failed (exit Some(96)) — this worker's, not the recipe's: rustc cannot start on this worker".into(),
        )
        .into();
        let b = fail_body(&native, 540_000);
        assert_eq!(b["needs_native"], true);
        assert_eq!(b["final"], false);
        assert_eq!(b["duration_ms"], 540_000);
        assert!(b["error"]
            .as_str()
            .unwrap()
            .contains("rustc cannot start on this worker"));
        // Wrapped in context on its way up, it is still this worker's.
        let wrapped = anyhow::Error::from(NeedsNative("x".into())).context("task 7");
        assert_eq!(fail_body(&wrapped, 1)["needs_native"], true);
        let gate = anyhow::anyhow!("build failed (exit Some(5)) — the gate:\n…");
        let b = fail_body(&gate, 1);
        assert_eq!(
            (b["final"].clone(), b["needs_native"].clone()),
            (serde_json::json!(true), serde_json::json!(false))
        );
        let other =
            anyhow::anyhow!("build failed (exit Some(4)):\nerror: could not compile `rusty`");
        let b = fail_body(&other, 1);
        assert_eq!(
            (b["final"].clone(), b["needs_native"].clone()),
            (serde_json::json!(false), serde_json::json!(false))
        );
    }
}
