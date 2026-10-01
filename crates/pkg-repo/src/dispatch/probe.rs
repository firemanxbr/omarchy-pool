//! The probe sidecar (design v2 §9.5, #336): who this host's agent is, and
//! whether it answers. A one-shot agent container (the worker image's
//! `agent` role, `--probe`: one tiny completion, `factory/bin/agent.py
//! --probe`) on a network of its own with its own egress sidecar, as a task's
//! agent sidecar runs — never the dispatcher, which holds no agent key and
//! joins no task network. Its answer is the claim's `agent` field
//! (`{provider, model, probe, error, checked_at}`), which the pool reads to
//! hand model work only to a host whose agent answers, and the answer to
//! `recheck-agent` (and `restart-agent`, which on a host has no long-running
//! service to restart and is answered by a fresh probe).
//!
//! Probed at start, every 30 minutes while it answers, and after a failure
//! again 15 s later, doubling to the half hour (as `pkg-repo work` does).

use serde_json::{json, Value};

use super::engine::{self, Engine};
use super::spec;

/// Between two probes of an agent that answers.
pub const EVERY: u64 = 30 * 60;
/// After the first failed probe; doubled at each failure in a row, up to [`EVERY`].
const RETRY_FIRST: u64 = 15;

/// The probe's answer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub ok: bool,
    /// The probe ran (its network, egress and container started), whatever the agent said.
    pub ran: bool,
    pub provider: String,
    pub model: String,
    pub error: String,
    pub checked_at: String,
    pub ms: u64,
}

impl Report {
    pub fn failed(error: impl Into<String>, ran: bool, checked_at: String) -> Self {
        Self {
            ran,
            error: error.into(),
            checked_at,
            ..Self::default()
        }
    }

    /// The claim's `agent` field (worker/src/routes/factory.ts hostAgent).
    pub fn claim(&self) -> Value {
        let mut v = json!({
            "probe": if self.ok { "ok" } else { "error" },
            "checked_at": self.checked_at,
        });
        if !self.provider.is_empty() && !self.model.is_empty() {
            v["provider"] = json!(self.provider);
            v["model"] = json!(self.model);
        }
        if !self.ok {
            v["error"] = json!(self.error);
        }
        v
    }

    /// One line for the order's answer and the log.
    pub fn detail(&self) -> String {
        if self.ok {
            format!(
                "agent {}/{} answers ({} ms)",
                self.provider, self.model, self.ms
            )
        } else {
            format!("agent does not answer: {}", self.error)
        }
    }
}

/// `agent.py --probe`'s one JSON line (the last line of its output that reads), with what the container said on stderr when it is not there.
pub fn parse(stdout: &str, stderr: &str, checked_at: String) -> Report {
    let line = stdout.lines().rev().find_map(|l| {
        serde_json::from_str::<Value>(l.trim())
            .ok()
            .filter(Value::is_object)
    });
    let Some(v) = line else {
        let said: String = stderr
            .trim()
            .lines()
            .last()
            .unwrap_or("no answer")
            .chars()
            .take(300)
            .collect();
        return Report::failed(
            format!("the probe said nothing readable: {said}"),
            true,
            checked_at,
        );
    };
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    // `agent` is who really answered ("provider/model"); behind a broker it names the real one.
    let (provider, model) = s("agent")
        .split_once('/')
        .map_or((s("provider"), s("model")), |(p, m)| {
            (p.to_owned(), m.to_owned())
        });
    let ok = v.get("ok").and_then(Value::as_bool) == Some(true);
    Report {
        ok,
        ran: true,
        provider,
        model,
        error: if ok {
            String::new()
        } else {
            let e = s("error");
            if e.is_empty() {
                "no answer".into()
            } else {
                e.chars().take(300).collect()
            }
        },
        checked_at,
        ms: v.get("ms").and_then(Value::as_u64).unwrap_or(0),
    }
}

/// Runs one probe: the network and its egress, the one-shot agent, then everything removed.
pub fn ask(engine: &dyn Engine, p: &spec::Probe<'_>, checked_at: impl Fn() -> String) -> Report {
    let (setup, run) = match spec::probe_plan(p) {
        Ok(x) => x,
        Err(why) => return Report::failed(format!("not probed: {why}"), false, checked_at()),
    };
    let report = (|| {
        engine::ensure_bridge(engine, p.host)
            .map_err(|e| Report::failed(format!("the egress bridge: {e}"), false, checked_at()))?;
        for c in &setup {
            engine.run(c).map_err(|e| {
                Report::failed(
                    format!("the probe's network did not start: {e}"),
                    false,
                    checked_at(),
                )
            })?;
        }
        let (stdout, stderr) = engine.output(&run).map_err(|e| {
            Report::failed(format!("the probe did not run: {e}"), false, checked_at())
        })?;
        Ok(parse(&stdout, &stderr, checked_at()))
    })()
    .unwrap_or_else(|r: Report| r);
    engine.remove_lease(0, p.gen);
    report
}

/// When to probe next after `failures` failed probes in a row (0: the agent answered).
pub fn next_after(now: u64, failures: u32) -> u64 {
    if failures == 0 {
        return now + EVERY;
    }
    now + RETRY_FIRST
        .saturating_mul(1 << failures.saturating_sub(1).min(16))
        .min(EVERY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_probe_prints_is_the_claims_agent() {
        let ok = parse(
            "omarchy-worker: something\n{\"ok\": true, \"provider\": \"anthropic\", \"model\": \"claude-sonnet-5\", \"agent\": \"claude-code/claude-sonnet-5\", \"ms\": 812}\n",
            "",
            "2026-10-02T00:00:00Z".into(),
        );
        assert!(ok.ok && ok.ran);
        assert_eq!(
            (ok.provider.as_str(), ok.model.as_str()),
            ("claude-code", "claude-sonnet-5")
        );
        assert_eq!(
            ok.claim(),
            json!({"probe": "ok", "provider": "claude-code", "model": "claude-sonnet-5", "checked_at": "2026-10-02T00:00:00Z"})
        );
        let bad = parse(
            "{\"ok\": false, \"provider\": \"anthropic\", \"error\": \"HTTP 401\"}\n",
            "",
            "t".into(),
        );
        assert!(!bad.ok);
        assert_eq!(bad.claim()["probe"], "error");
        assert_eq!(bad.claim()["error"], "HTTP 401");
        let silent = parse(
            "",
            "omarchy-worker: no agent key in /run/omarchy/agent.env\n",
            "t".into(),
        );
        assert!(!silent.ok && silent.error.contains("no agent key"));
    }

    #[test]
    fn the_schedule() {
        assert_eq!(next_after(100, 0), 100 + EVERY);
        assert_eq!(next_after(100, 1), 115);
        assert_eq!(next_after(100, 2), 130);
        assert_eq!(next_after(100, 3), 160);
        assert_eq!(next_after(100, 30), 100 + EVERY);
    }
}
