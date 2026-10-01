//! Rollback statements (design v2 §5.3), signed by `rollback.yml` and relayed by the pool.
//!
//! Parsed strictly once the signature verified. A `schema` this agent does not know means
//! "update myself first", never a refusal. Whether a statement is *accepted* (`seq` rises,
//! `to < floor <= retracts_through`, the depth bound, `to`'s bundle verifies) needs the
//! host's state and is decided by the run loop (P1); only the statement's own consistency
//! is checked here.

use serde::Deserialize;

use crate::manifest::{is_timestamp, ManifestError};
use crate::version::Version;

pub const STATEMENT_SCHEMA: u64 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatementRaw {
    schema: u64,
    seq: u64,
    to: String,
    retracts_through: String,
    issued: String,
    agent_to: Option<String>,
    run: String,
}

/// A verified rollback statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    seq: u64,
    to: Version,
    retracts_through: Version,
    issued: String,
    agent_to: Option<Version>,
    run: String,
}

impl Statement {
    pub fn seq(&self) -> u64 {
        self.seq
    }
    /// The release to go back to.
    pub fn to(&self) -> Version {
        self.to
    }
    /// Every release above `to` up to this one is retracted.
    pub fn retracts_through(&self) -> Version {
        self.retracts_through
    }
    pub fn issued(&self) -> &str {
        &self.issued
    }
    /// The agent version to go back to, when the statement names one.
    pub fn agent_to(&self) -> Option<Version> {
        self.agent_to
    }
    pub fn run(&self) -> &str {
        &self.run
    }
}

#[derive(Debug)]
pub enum ParsedStatement {
    Current(Statement),
    NeedsNewerAgent { why: String },
}

fn bad<T>(m: String) -> Result<T, ManifestError> {
    Err(ManifestError(m))
}

const RUNS: &str = "https://github.com/firemanxbr/omarchy-pool/actions/runs/";

/// Reads a verified statement. Called by [`crate::verify`] only, on signed bytes.
pub(crate) fn parse(bytes: &[u8]) -> Result<ParsedStatement, ManifestError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).or_else(|e| bad(format!("statement: {e}")))?;
    let Some(schema) = value.get("schema").and_then(serde_json::Value::as_u64) else {
        return bad("statement: schema is missing or not a number".into());
    };
    if schema > STATEMENT_SCHEMA {
        let why = format!(
            "statement schema {schema} is newer than this agent reads ({STATEMENT_SCHEMA})"
        );
        return Ok(ParsedStatement::NeedsNewerAgent { why });
    }
    let raw = StatementRaw::deserialize(value).or_else(|e| bad(format!("statement: {e}")))?;
    if raw.schema != STATEMENT_SCHEMA {
        return bad(format!(
            "statement schema {} is not {STATEMENT_SCHEMA}",
            raw.schema
        ));
    }
    let release = |what: &str, s: &str| {
        Version::parse_release(s)
            .ok_or_else(|| ManifestError(format!("statement: {what} {s:?} is not vX.Y.Z")))
    };
    let to = release("to", &raw.to)?;
    let retracts_through = release("retracts_through", &raw.retracts_through)?;
    if to >= retracts_through {
        return bad("statement: to must be below retracts_through".into());
    }
    if !is_timestamp(&raw.issued) {
        return bad(format!(
            "statement: issued {:?} is not an RFC 3339 UTC time",
            raw.issued
        ));
    }
    let agent_to = match raw.agent_to {
        None => None,
        Some(a) => Some(
            Version::parse(&a)
                .ok_or_else(|| ManifestError(format!("statement: agent_to {a:?} is not X.Y.Z")))?,
        ),
    };
    let run_ok = raw.run.strip_prefix(RUNS).is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 64
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'/')
    });
    if !run_ok {
        return bad(format!(
            "statement: run is not a run of this repository ({RUNS}...)"
        ));
    }
    Ok(ParsedStatement::Current(Statement {
        seq: raw.seq,
        to,
        retracts_through,
        issued: raw.issued,
        agent_to,
        run: raw.run,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse, ParsedStatement};

    fn example() -> serde_json::Value {
        json!({"schema": 1, "seq": 7, "to": "v1.13.4", "retracts_through": "v1.14.2",
               "issued": "2026-10-20T14:00:00Z", "agent_to": null,
               "run": "https://github.com/firemanxbr/omarchy-pool/actions/runs/123/attempts/1"})
    }

    fn read(v: &serde_json::Value) -> Result<ParsedStatement, String> {
        parse(&serde_json::to_vec(v).unwrap()).map_err(|e| e.0)
    }

    #[test]
    fn reads_the_design_example() {
        let Ok(ParsedStatement::Current(s)) = read(&example()) else {
            panic!()
        };
        assert_eq!(
            (s.seq(), s.to().to_string(), s.agent_to()),
            (7, "1.13.4".into(), None)
        );
        let mut v = example();
        v["agent_to"] = json!("0.3.0");
        let Ok(ParsedStatement::Current(s)) = read(&v) else {
            panic!()
        };
        assert_eq!(s.agent_to().unwrap().to_string(), "0.3.0");
    }

    #[test]
    fn a_newer_schema_needs_a_newer_agent_and_anything_else_unknown_is_refused() {
        assert!(matches!(
            read(&json!({"schema": 2, "new": true})),
            Ok(ParsedStatement::NeedsNewerAgent { .. })
        ));
        let mut v = example();
        v["extra"] = json!(1);
        assert!(read(&v).unwrap_err().contains("unknown field `extra`"));
        for (field, value) in [
            ("to", json!("v1.15.0")),
            ("retracts_through", json!("latest")),
            ("issued", json!(0)),
            ("agent_to", json!("v0.3.0")),
            (
                "run",
                json!("https://github.com/someone/else/actions/runs/1"),
            ),
            ("schema", json!(0)),
        ] {
            let mut v = example();
            v[field] = value;
            assert!(read(&v).is_err(), "{field}");
        }
    }
}
