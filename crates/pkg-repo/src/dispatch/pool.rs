//! The pool as the dispatcher speaks to it: with the host's worker token, the
//! claim and the orders' answers; with each lease's own job token, everything
//! about that lease — its heartbeat, its inputs, its uploads, its report.
//! Every pool call of a task is made here, by the dispatcher, after or before
//! the task container ran: no task container ever calls the pool (D47). A
//! trait, so the loop's tests run on a fake pool.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::client::Api;
use crate::ops;
use crate::stop::{self, Beat};
use crate::RepoError;

/// The loop's own calls (claim, heartbeat, report, an order's answer) end within
/// `client::longest_call` of this, about two minutes with their retries: a pool that
/// does not answer never holds the loop near its watchdog's 15 minutes.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

pub trait Pool: Send + Sync {
    /// `POST /factory/claim` with the host's worker token: `None` on 204.
    fn claim(&self, body: &Value) -> Result<Option<Value>, RepoError>;
    /// `GET /factory/workers/self`: the registration's id.
    fn whoami(&self) -> Result<String, RepoError>;
    /// The answer to an order, with the worker token.
    fn answer(&self, order: &str, body: &Value) -> Result<(), RepoError>;
    /// One heartbeat of a lease, with its job token.
    fn heartbeat(&self, task: u64, token: &str) -> Beat;
    fn complete(&self, task: u64, token: &str, body: &Value) -> Result<(), RepoError>;
    fn fail(&self, task: u64, token: &str, body: &Value) -> Result<(), RepoError>;
    /// A file into a task's staging (`PUT /factory/tasks/:to/artifacts/:name`, multipart above 90 MB).
    fn stage(&self, token: &str, to: u64, name: &str, file: &Path) -> Result<(), RepoError>;
    /// A staged artifact of task `of` into `dest`; `Ok(false)` when it has none by that name.
    fn fetch(&self, token: &str, of: u64, name: &str, dest: &Path) -> Result<bool, RepoError>;
    /// A staged artifact only this job may read (a project build's package, for its trial).
    fn fetch_private(&self, token: &str, of: u64, name: &str, dest: &Path)
        -> Result<(), RepoError>;
    fn post_event(&self, token: &str, event: &Value) -> Result<(), RepoError>;
    /// Packages into `ring` as source `factory` (the pool signs), then the ring rendered for
    /// `arch` — and for the other architecture too when `both` (edge: a release covers both).
    fn publish(
        &self,
        token: &str,
        ring: &str,
        arch: &str,
        note: &str,
        pkgs: &[PathBuf],
        both: bool,
    ) -> anyhow::Result<Vec<String>>;
    /// The pool's public URL (`OMARCHY_API`): what a trial's include is read from.
    fn api_url(&self) -> &str;
}

/// The pool over HTTPS.
pub struct Http {
    pub api: String,
    pub worker_token: String,
}

impl Http {
    fn short(&self, token: &str) -> Result<Api, RepoError> {
        Api::with_timeout(&self.api, token, CALL_TIMEOUT)
    }
    fn long(&self, token: &str) -> Result<Api, RepoError> {
        Api::new(&self.api, token)
    }
}

impl Pool for Http {
    fn claim(&self, body: &Value) -> Result<Option<Value>, RepoError> {
        self.short(&self.worker_token)?
            .post_json_as(&self.worker_token, "/factory/claim", body)
    }

    fn whoami(&self) -> Result<String, RepoError> {
        let v = self
            .short(&self.worker_token)?
            .get_json("/factory/workers/self")?;
        v.get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| RepoError::Api {
                status: 200,
                body: format!("no id in {v}"),
            })
    }

    fn answer(&self, order: &str, body: &Value) -> Result<(), RepoError> {
        self.short(&self.worker_token)?
            .post_json_as(
                &self.worker_token,
                &format!("/factory/workers/self/orders/{order}"),
                body,
            )
            .map(|_| ())
    }

    fn heartbeat(&self, task: u64, token: &str) -> Beat {
        let answer = self.short(token).and_then(|c| {
            c.post_json_as(
                token,
                &format!("/factory/tasks/{task}/heartbeat"),
                &serde_json::json!({}),
            )
        });
        stop::beat_of(&answer)
    }

    fn complete(&self, task: u64, token: &str, body: &Value) -> Result<(), RepoError> {
        self.short(token)?
            .post_json_as(token, &format!("/factory/tasks/{task}/complete"), body)
            .map(|_| ())
    }

    fn fail(&self, task: u64, token: &str, body: &Value) -> Result<(), RepoError> {
        self.short(token)?
            .post_json_as(token, &format!("/factory/tasks/{task}/fail"), body)
            .map(|_| ())
    }

    fn stage(&self, token: &str, to: u64, name: &str, file: &Path) -> Result<(), RepoError> {
        self.long(token)?.stage_file(to, name, file)
    }

    fn fetch(&self, token: &str, of: u64, name: &str, dest: &Path) -> Result<bool, RepoError> {
        let job = self.long(token)?;
        let url = format!("{}/api/v1/factory/tasks/{of}/artifacts/{name}", job.base());
        match job.download(&url, dest) {
            Ok(_) => Ok(true),
            Err(RepoError::Api { status: 404, .. }) => {
                let _ = std::fs::remove_file(dest);
                Ok(false)
            }
            Err(e) => {
                let _ = std::fs::remove_file(dest);
                Err(e)
            }
        }
    }

    fn fetch_private(
        &self,
        token: &str,
        of: u64,
        name: &str,
        dest: &Path,
    ) -> Result<(), RepoError> {
        let job = self.long(token)?;
        let url = format!("{}/api/v1/factory/tasks/{of}/artifacts/{name}", job.base());
        job.download_as_self(&url, dest).map(|_| ())
    }

    fn post_event(&self, token: &str, event: &Value) -> Result<(), RepoError> {
        self.long(token)?.post_event(event)
    }

    fn publish(
        &self,
        token: &str,
        ring: &str,
        arch: &str,
        note: &str,
        pkgs: &[PathBuf],
        both: bool,
    ) -> anyhow::Result<Vec<String>> {
        let job = self.long(token)?;
        ops::publish(&job, ring, "factory", arch, Some(note), pkgs)?;
        let mut rendered = ops::render(&job, ring, arch, None)?;
        if both {
            let other = if arch == "aarch64" {
                "x86_64"
            } else {
                "aarch64"
            };
            rendered.extend(ops::render(&job, ring, other, None)?);
        }
        Ok(rendered)
    }

    fn api_url(&self) -> &str {
        &self.api
    }
}
