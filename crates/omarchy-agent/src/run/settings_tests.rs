//! #325's acceptance criteria on the agent's side, against the fake engine and pool (the
//! real-engine narrowing is `tests/agent-host-orders.sh`'s): the settings the pool narrows
//! inside the envelope — units and emulated lanes — reaching `run/capacity.json` and the
//! dispatcher, never above the envelope and never killing a task; the other host orders
//! (`rotate-token`, `retry-release`, `diagnostics`); the refusals; the host-side brake on a
//! fake clock, across a restart too; and the report that carries the settings.

use std::fs;

use serde_json::{json, Value};

use crate::dispatcher_env::{Budget, Sources};
use crate::run::agent::HostEnv;
use crate::run::brake::Ask;
use crate::run::fake::World;
use crate::run::pool::{parse_state, Net};
use crate::run::settings::Settings;

/// The other architecture than this machine's: the emulated lane's.
fn foreign() -> &'static str {
    if std::env::consts::ARCH == "x86_64" {
        "aarch64"
    } else {
        "x86_64"
    }
}

/// The Studio's `run/capacity.json` as detection writes it (11 units, its native lane and
/// an emulated one), on a host whose envelope allows 8 units and leaves emulation to
/// detection.
fn studio() -> World {
    let mut w = World::running_v1();
    w.agent.cfg.policy.max_units = Some(8);
    w.agent.cfg.policy.emulate = None;
    fs::write(
        w.set_dir().join("run/capacity.json"),
        studio_file().to_string(),
    )
    .unwrap();
    settle(&mut w);
    w
}

fn studio_file() -> Value {
    json!({
        "schema": 2, "at": "2027-01-15T07:00:00Z", "cpus": 12, "mem_gb": 32, "page_kb": 4,
        "disk_free_gb": {"work": 410, "engine": 220}, "units": 11, "job_reserved": 1, "agent_slots": 2,
        "lanes": [{"arch": std::env::consts::ARCH, "mode": "native"}, {"arch": foreign(), "mode": "emulated", "via": "qemu"}],
        "isolation": "root", "dedicated": true,
        "limits": {"cpus_hard": true, "memory_hard": true, "pids": true}, "below_minimum": false
    })
}

/// Ticks until no round runs (a changed input starts one at the next tick).
fn settle(w: &mut World) {
    for _ in 0..200 {
        w.tick(3);
        if w.step() == "idle" {
            w.tick(3);
            if w.step() == "idle" {
                return;
            }
        }
    }
    panic!("no end: {:?}", w.agent.state.rollout);
}

fn capacity(w: &World) -> Value {
    serde_json::from_slice(&fs::read(w.set_dir().join("run/capacity.json")).unwrap()).unwrap()
}

/// The pool's host state with `orders` (objects as it sends them, `not_after` an hour on
/// unless given), read by the agent's own parser.
fn give(w: &World, orders: &[Value]) {
    let orders: Vec<Value> = orders
        .iter()
        .map(|o| {
            let mut o = o.clone();
            if o.get("not_after").is_none() {
                o["not_after"] = (w.now + 3600).into();
            }
            o
        })
        .collect();
    let body = json!({"release": {"target": "v1.0.0"}, "poll_s": 120, "orders": orders});
    w.pool_answers(Net::Ok(parse_state(body.to_string().as_bytes()).unwrap()));
}

/// Gives `order` and polls until it is answered: the brake paces orders, and a round
/// order waits while a commit finishes (the next poll lists it again).
fn order(w: &mut World, order: &Value) -> (String, String) {
    let id = order["id"].as_str().unwrap().to_owned();
    give(w, std::slice::from_ref(order));
    for _ in 0..10 {
        w.poll();
        if let Some(a) = w.agent.state.orders.answers.iter().find(|a| a.id == id) {
            return (a.outcome.clone(), a.detail.clone());
        }
    }
    panic!("{id} was not answered: {:?}", w.agent.state.orders.answers);
}

fn dispatcher_id(w: &World) -> String {
    w.engine.borrow().dispatcher().unwrap().id.clone()
}

#[test]
fn narrowing_units_from_the_site_reaches_the_next_claim_never_above_the_envelope_and_kills_no_task()
{
    let mut w = studio();
    let task = w.engine.borrow().tasks()[0].id.clone();
    let before = dispatcher_id(&w);
    // The envelope's 8 apply already: the file says so, and keeps what detection found.
    assert_eq!(capacity(&w)["units"], 8);
    assert_eq!(capacity(&w)["detected"]["units"], 11);

    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_u4", "kind": "set-units", "units": 4}),
    );
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        detail
            .starts_with("units 8 → 4 (its envelope gives 8); the dispatcher is recreated with it"),
        "{detail}"
    );
    let f = capacity(&w);
    assert_eq!(
        (f["units"].as_u64(), f["job_reserved"].as_u64()),
        (Some(4), Some(1))
    );
    assert_eq!(f["settings"]["units"], 4);
    assert_eq!(
        w.agent.state.settings,
        Some(Settings {
            units: Some(4),
            emulate: None
        })
    );
    // The dispatcher is recreated with the file (its bind mount holds the one it was created
    // with), so its next claim carries 4 units; the task above them runs on, untouched.
    settle(&mut w);
    assert_ne!(dispatcher_id(&w), before);
    let t = w.engine.borrow().tasks()[0].clone();
    assert_eq!(
        (t.id.as_str(), t.status.as_str()),
        (task.as_str(), "running")
    );
    assert!(!w
        .changes()
        .iter()
        .any(|c| c.ends_with(&task[task.len() - 4..])));

    // Above the envelope: refused on the host, nothing changed.
    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_u9", "kind": "set-units", "units": 9}),
    );
    assert_eq!(outcome, "refused");
    assert_eq!(
        detail,
        "9 units is above this host's envelope: its envelope's max_units is 8 (detected 11), and only its owner widens that, at the host"
    );
    assert_eq!(capacity(&w)["units"], 4);
    // The envelope's own back (`null`): from what detection found, never from the narrowing.
    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_un", "kind": "set-units", "units": null}),
    );
    assert_eq!(outcome, "done", "{detail}");
    assert!(detail.starts_with("units 4 → 8"), "{detail}");
    assert_eq!(capacity(&w)["units"], 8);

    // The report carries the settings, the envelope and what applies: the host page's.
    settle(&mut w);
    w.tick(20);
    let r = w.last_report();
    assert_eq!(r["settings"]["envelope"]["max_units"], 8);
    assert_eq!(r["settings"]["envelope"]["detected_units"], 11);
    assert_eq!(r["settings"]["effective"]["units"], 8);
    assert_eq!(r["capacity"]["units"], 8);
    assert!(r["capacity"].get("detected").is_none(), "{r}");
    assert_eq!(r["runtime"]["driver"], "compose/docker");
}

#[test]
fn an_emulated_lane_turned_off_leaves_the_claims_and_one_the_envelope_excludes_is_refused() {
    let mut w = studio();
    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_e0", "kind": "set-emulate", "emulate": []}),
    );
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        detail.starts_with(&format!("emulated lanes {} → none", foreign())),
        "{detail}"
    );
    // The file the dispatcher claims by names the native lane only: no emulated claim.
    assert_eq!(
        capacity(&w)["lanes"],
        json!([{"arch": std::env::consts::ARCH, "mode": "native"}])
    );
    // The owner's envelope excludes it: turning it on from the site is refused, and said.
    w.agent.cfg.policy.emulate = Some(Vec::new());
    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_e1", "kind": "set-emulate", "emulate": [foreign()]}),
    );
    assert_eq!(outcome, "refused");
    assert_eq!(
        detail,
        format!("{}'s emulated lane is one the envelope excludes (emulate = [] in agent.toml): only its owner widens that, at the host", foreign())
    );
    assert_eq!(capacity(&w)["lanes"].as_array().unwrap().len(), 1);
    // The native lane is never one to turn off this way.
    w.agent.cfg.policy.emulate = None;
    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_e2", "kind": "set-emulate", "emulate": [std::env::consts::ARCH]}),
    );
    assert_eq!(outcome, "refused");
    assert!(detail.contains("native lane"), "{detail}");
    // Allowed again by the envelope: on.
    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_e3", "kind": "set-emulate", "emulate": [foreign()]}),
    );
    assert_eq!(outcome, "done", "{detail}");
    assert_eq!(capacity(&w)["lanes"].as_array().unwrap().len(), 2);
}

#[test]
fn unknown_expired_repeated_and_unreadable_orders_are_refused() {
    let mut w = studio();
    give(
        &w,
        &[
            json!({"id": "ho_k", "kind": "drain-host"}),
            json!({"id": "ho_x", "kind": "set-units", "units": 3, "not_after": w.now - 1}),
            json!({"id": "ho_m", "kind": "set-units", "units": "three"}),
            json!({"id": "ho_n", "kind": "set-emulate", "emulate": "x86_64"}),
        ],
    );
    w.poll();
    let got: Vec<(&str, &str, &str)> = w
        .agent
        .state
        .orders
        .answers
        .iter()
        .map(|a| (a.id.as_str(), a.outcome.as_str(), a.detail.as_str()))
        .collect();
    assert_eq!(got.len(), 4, "{got:?}");
    assert!(got.iter().all(|a| a.1 == "refused"), "{got:?}");
    assert!(
        got[0].2.starts_with("unknown kind \"drain-host\""),
        "{got:?}"
    );
    assert!(got[1].2.starts_with("expired at "), "{got:?}");
    assert_eq!(
        got[2].2,
        "its units are not a whole number this agent can read"
    );
    assert_eq!(
        got[3].2,
        "its emulate is not a list of architectures this agent can read"
    );
    assert_eq!(capacity(&w)["units"], 8, "nothing narrowed");
    // A repeated id: taken once, its first answer stands.
    let (outcome, _) = order(
        &mut w,
        &json!({"id": "ho_once", "kind": "set-units", "units": 5}),
    );
    assert_eq!(outcome, "done");
    give(
        &w,
        &[json!({"id": "ho_once", "kind": "set-units", "units": 2})],
    );
    w.poll();
    w.tick(2);
    assert_eq!(capacity(&w)["units"], 5);
    assert!(w
        .journal()
        .contains("seen already: an order id is taken once, and its first answer stands"));
}

#[test]
fn the_brake_refuses_the_seventh_restart_and_the_fifth_narrowing_and_a_restart_resets_nothing() {
    let mut w = studio();
    // Four narrowings in an hour: done; the fifth is refused.
    for (i, n) in [7, 6, 5, 4].iter().enumerate() {
        let (outcome, detail) = order(
            &mut w,
            &json!({"id": format!("ho_n{i}"), "kind": "set-units", "units": n}),
        );
        assert_eq!(outcome, "done", "{i}: {detail}");
    }
    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_n4", "kind": "set-units", "units": 3}),
    );
    assert_eq!(outcome, "refused");
    assert!(
        detail.starts_with(
            "brake: at most 4 capacity narrowings an hour; 4 in the last 60 min, the next from "
        ),
        "{detail}"
    );
    assert_eq!(capacity(&w)["units"], 4);
    // The four narrowings recreated the dispatcher four times; two token rotations make six,
    // and the seventh restart is refused.
    for i in 0..2 {
        let (outcome, detail) = order(
            &mut w,
            &json!({"id": format!("ho_t{i}"), "kind": "rotate-token"}),
        );
        assert_eq!(outcome, "done", "{detail}");
    }
    let tokens = w.remote.borrow().tokens;
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_t2", "kind": "rotate-token"}));
    assert_eq!(outcome, "refused");
    assert!(
        detail.starts_with(
            "brake: at most 6 restarts of the dispatcher an hour; 6 in the last 60 min"
        ),
        "{detail}"
    );
    assert_eq!(
        w.remote.borrow().tokens,
        tokens,
        "the pool was not even asked"
    );
    // A restart of the agent resets nothing: the counters are in state.json.
    settle(&mut w);
    w.restart();
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_t3", "kind": "rotate-token"}));
    assert_eq!(outcome, "refused", "{detail}");
    // An hour on, both have room again.
    w.tick(3600);
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_t4", "kind": "rotate-token"}));
    assert_eq!(outcome, "done", "{detail}");
    let (outcome, detail) = order(
        &mut w,
        &json!({"id": "ho_n5", "kind": "set-units", "units": 3}),
    );
    assert_eq!(outcome, "done", "{detail}");
}

#[test]
fn a_second_release_change_within_ten_minutes_waits_but_a_rollback_does_not() {
    let mut w = World::running_v1();
    for r in ["v1.1.0", "v1.2.0"] {
        w.release(r);
    }
    w.target("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    // A second change within ten minutes: held, said, nothing replaced.
    w.target("v1.2.0", None);
    let changes = w.changes().len();
    w.round_now();
    assert_eq!(w.step(), "idle");
    assert_eq!(w.outcome().0, "held");
    assert!(
        w.outcome()
            .1
            .starts_with("v1.2.0 waits: brake: at most one release change every 10 minutes"),
        "{:?}",
        w.outcome()
    );
    assert_eq!(w.changes().len(), changes);
    // A rollback under a signed statement is exempt: back to v1.0.0 at once.
    crate::run::fake::relay_statement(&w.remote, 1, "v1.0.0", "v1.1.0", b"signed");
    w.target("v1.0.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"), "{:?}", w.outcome());
    // Ten minutes after the last change, the next goes.
    w.tick(600);
    w.target("v1.2.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"), "{:?}", w.outcome());
}

#[test]
fn twenty_orders_an_hour_and_two_seconds_between_them() {
    let mut w = studio();
    w.agent.cfg.policy.diagnostics = true;
    // Two orders in one host state: the second is taken two seconds after the first.
    give(
        &w,
        &[
            json!({"id": "ho_p1", "kind": "reconcile-now"}),
            json!({"id": "ho_p2", "kind": "diagnostics"}),
        ],
    );
    w.poll();
    let answered = |w: &World| w.agent.state.orders.answers.len();
    assert_eq!(answered(&w), 1);
    w.tick(1);
    assert_eq!(answered(&w), 1);
    w.tick(1);
    assert_eq!(answered(&w), 2);
    // Eighteen more, two seconds apart: twenty in the hour; the twenty-first is refused.
    for i in 0..18 {
        let (outcome, detail) = order(
            &mut w,
            &json!({"id": format!("ho_r{i}"), "kind": "reconcile-now"}),
        );
        assert_eq!(outcome, "done", "{i}: {detail}");
    }
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_r18", "kind": "reconcile-now"}));
    assert_eq!(outcome, "refused");
    assert!(
        detail.starts_with("brake: at most 20 host orders an hour"),
        "{detail}"
    );
}

#[test]
fn diagnostics_are_the_dispatchers_last_lines_scrubbed_and_only_when_the_envelope_allows_them() {
    let mut w = studio();
    let secrets = w.dir.join("secrets");
    fs::create_dir_all(&secrets).unwrap();
    fs::write(
        secrets.join("agent.env"),
        "ANTHROPIC_API_KEY=sk-ant-api03-key-of-the-owner-0123456789\n",
    )
    .unwrap();
    {
        let mut e = w.engine.borrow_mut();
        for i in 0..600 {
            e.log
                .push(format!("2027-01-15T08:00:00.{i:09}Z claimed task {i}"));
        }
        e.log.push(format!(
            "2027-01-15T08:00:01.000000000Z token {} key sk-ant-api03-key-of-the-owner-0123456789 gh ghp_abcdefghijklmnopqrstuvwxyz0123456789 job omj.eyJ0YXNrIjoxMjMsImV4cCI6MX0.c2lnbmF0dXJlLW9mLXRoZS1wb29s. agent oma_0123456789abcdef0123456789abcdef0123456789abcdef",
            crate::run::fake::TOKEN
        ));
    }
    // The envelope says no (agent.toml's default): refused, nothing read or sent.
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_d0", "kind": "diagnostics"}));
    assert_eq!(outcome, "refused");
    assert_eq!(
        detail,
        "its envelope does not allow diagnostics (diagnostics = false in agent.toml): only its owner allows them, at the host"
    );
    assert!(w.remote.borrow().diagnostics.is_empty());
    // The owner allows them.
    w.agent.cfg.policy.diagnostics = true;
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_d1", "kind": "diagnostics"}));
    assert_eq!(outcome, "done", "{detail}");
    assert_eq!(
        detail,
        "500 line(s) of the dispatcher's log, scrubbed of the host's secrets, are on the host's page"
    );
    let sent = w.remote.borrow().diagnostics[0].clone();
    assert_eq!(sent["order"], "ho_d1");
    let lines: Vec<&str> = sent["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    assert_eq!(lines.len(), 500);
    let last = lines[499];
    assert_eq!(
        last,
        "2027-01-15T08:00:01.000000000Z token [redacted] key [redacted] gh [redacted] job [redacted]. agent [redacted]"
    );
    for secret in [
        crate::run::fake::TOKEN,
        "sk-ant-api03",
        "ghp_abc",
        "omj.",
        "oma_",
    ] {
        assert!(!sent.to_string().contains(secret), "{secret}");
    }
    assert!(lines[0].ends_with("claimed task 101"), "{}", lines[0]);
}

#[test]
fn diagnostics_full_of_quotes_stay_within_what_the_pool_takes() {
    let mut w = studio();
    w.agent.cfg.policy.diagnostics = true;
    {
        // The dispatcher logs the pool's JSON answers: every quote is two bytes in the body.
        let mut e = w.engine.borrow_mut();
        for i in 0..500 {
            e.log.push(format!(
                "2027-01-15T08:00:00.{i:09}Z pool answered 409: {}",
                r#"{"error":"lease","code":"x"}"#.repeat(9)
            ));
        }
    }
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_dq", "kind": "diagnostics"}));
    assert_eq!(outcome, "done", "{detail}");
    let sent = w.remote.borrow().diagnostics[0].clone();
    let body = sent.to_string();
    assert!(body.len() <= 64 << 10, "{} bytes", body.len());
    let lines = sent["lines"].as_array().unwrap();
    assert!(lines.len() < 500, "{}", lines.len());
    assert!(
        detail.starts_with(&format!("{} line(s)", lines.len())),
        "{detail}"
    );
    // The newest ones.
    assert!(lines
        .last()
        .unwrap()
        .as_str()
        .unwrap()
        .starts_with("2027-01-15T08:00:00.000000499Z"));
}

#[test]
fn rotate_token_writes_a_new_token_for_the_dispatcher_which_is_recreated_with_it() {
    let mut w = studio();
    // etc/dispatcher.env as the run loop renders it (#371): the host's own addresses, the
    // secrets directory, the agent budget — and a line of the owner's.
    let net = w.dir.join("net");
    fs::create_dir_all(&net).unwrap();
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/addresses/home");
    for f in ["fib_trie", "if_inet6", "route"] {
        fs::copy(fixture.join(f), net.join(f)).unwrap();
    }
    w.agent.host_env = Some(HostEnv::new(Sources {
        proc_net: net,
        ifconfig: None,
    }));
    w.agent.cfg.agent_budget = Budget {
        calls_per_task: Some(40),
        ..Budget::default()
    };
    let env = w.set_dir().join("etc/dispatcher.env");
    w.tick(3);
    let mut owners = fs::read_to_string(&env).unwrap();
    owners.push_str("# the owner's own\nOWNER_NOTE=kept\n");
    fs::write(&env, &owners).unwrap();
    settle(&mut w);
    let rendered = fs::read_to_string(&env).unwrap();
    for line in [
        "OMARCHY_HOST_ADDRESSES=10.8.0.2,192.168.1.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64",
        &format!("OMARCHY_SECRETS_DIR={}", w.agent.cfg.secrets_dir.display()),
        "OMARCHY_AGENT_CALLS_PER_TASK=40",
        "OWNER_NOTE=kept",
    ] {
        assert!(rendered.lines().any(|l| l == line), "{line}: {rendered}");
    }
    let before = dispatcher_id(&w);
    let task = w.engine.borrow().tasks()[0].id.clone();
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_rt", "kind": "rotate-token"}));
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        detail.starts_with(
            "a new host worker token is in etc/dispatcher.env (next rotation after 2027-02-14T08:00:00.000Z)"
        ),
        "{detail}"
    );
    let text = fs::read_to_string(&env).unwrap();
    let token = format!("omw_{:048x}", 1);
    // Only the token changed: the addresses, the secrets directory, the budget and the
    // owner's lines are as they were, byte for byte.
    assert_eq!(
        text,
        rendered.replace(
            &format!("OMARCHY_WORKER_TOKEN={}\n", crate::run::fake::TOKEN),
            &format!("# worker: m1-test-0a9z\nOMARCHY_WORKER_TOKEN={token}\n")
        )
    );
    settle(&mut w);
    assert_ne!(dispatcher_id(&w), before);
    assert_eq!(w.engine.borrow().tasks()[0].id, task);
    // The new token never reaches the journal or a report.
    w.tick(20);
    assert!(!w.journal().contains(&token));
    assert!(!w.last_report().to_string().contains(&token));

    // An answer for another registration: nothing written.
    w.remote.borrow_mut().token_answer = Some(Net::Ok(
        json!({"worker": "m1-other-0a9z", "token": format!("omw_{:048x}", 9)}),
    ));
    let (outcome, detail) = order(&mut w, &json!({"id": "ho_rt2", "kind": "rotate-token"}));
    assert_eq!(outcome, "refused");
    assert!(
        detail.starts_with(
            "the pool's answer names registration m1-other-0a9z, not this host's m1-test-0a9z: nothing was written"
        ),
        "{detail}"
    );
    assert_eq!(fs::read_to_string(&env).unwrap(), text);
    // One with a newline in its token: nothing written either.
    w.remote.borrow_mut().token_answer = Some(Net::Ok(
        json!({"worker": "m1-test-0a9z", "token": "omw_x\nEVIL=1"}),
    ));
    let (outcome, _) = order(&mut w, &json!({"id": "ho_rt3", "kind": "rotate-token"}));
    assert_eq!(outcome, "refused");
    assert_eq!(fs::read_to_string(&env).unwrap(), text);
}

#[test]
fn retry_release_lifts_the_quarantine_and_tries_the_release_again() {
    let mut w = World::running_v1();
    crate::run::fake::publish(
        &w.remote,
        "v1.1.0",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "    command: [broken]\n",
    );
    w.target("v1.1.0", None);
    w.round();
    assert_eq!(w.outcome().0, "rolled-back");
    assert!(!w.agent.state.quarantine.is_empty());
    // The first try recreated the dispatcher twice, both the pool's restarts on the brake:
    // its replace and its revert's.
    let restarts = w.agent.state.brake.count(Ask::Restart, w.now);
    assert_eq!(restarts, 2);
    // The order: the quarantine lifted, a round to v1.1.0 now (the same change tried again).
    let body = json!({"release": {"target": "v1.1.0"}, "poll_s": 120,
        "orders": [{"id": "ho_retry", "kind": "retry-release", "not_after": w.now + 3600}]});
    w.pool_answers(Net::Ok(parse_state(body.to_string().as_bytes()).unwrap()));
    w.poll();
    let a = w
        .agent
        .state
        .orders
        .answers
        .iter()
        .find(|a| a.id == "ho_retry")
        .unwrap()
        .clone();
    assert_eq!(a.outcome, "done");
    assert!(
        a.detail.starts_with(
            "lifted the quarantine of v1.1.0; a round now: host order ho_retry (retry-release)"
        ),
        "{}",
        a.detail
    );
    assert!(
        w.journal()
            .contains(r#""by":"ho_retry","event":"quarantine-lifted""#),
        "{}",
        w.journal()
    );
    assert_eq!(
        w.agent
            .state
            .rollout
            .target
            .map(|r| r.to_string())
            .as_deref(),
        Some("v1.1.0")
    );
    // Still broken: reverted again, now until a newer release; its replace and its revert's
    // are two more of the pool's restarts.
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "rolled-back");
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.agent.state.brake.count(Ask::Restart, w.now), restarts + 2);
    // Without room for another such round (two restarts), a retry-release is refused and
    // the quarantine kept.
    w.agent.state.brake.record(w.now, &[Ask::Restart]);
    let body = json!({"release": {"target": "v1.1.0"}, "poll_s": 120,
        "orders": [{"id": "ho_retry2", "kind": "retry-release", "not_after": w.now + 3600}]});
    w.pool_answers(Net::Ok(parse_state(body.to_string().as_bytes()).unwrap()));
    w.tick(3);
    w.poll();
    let a = w
        .agent
        .state
        .orders
        .answers
        .iter()
        .find(|a| a.id == "ho_retry2")
        .unwrap();
    assert_eq!(a.outcome, "refused");
    assert!(
        a.detail.starts_with("brake: at most 6 restarts of the dispatcher an hour; 5 in the last 60 min (a round to another release keeps room for its revert)"),
        "{}",
        a.detail
    );
    assert!(!w.agent.state.quarantine.is_empty());
    assert_eq!(w.step(), "idle");
}

#[test]
fn updates_for_a_release_this_host_reverts_recreate_the_dispatcher_at_most_six_times_an_hour() {
    let mut w = World::running_v1();
    crate::run::fake::publish(
        &w.remote,
        "v1.1.0",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "    command: [broken]\n",
    );
    let creates = |w: &World| {
        w.changes()
            .iter()
            .filter(|c| c.starts_with("create "))
            .count()
    };
    let (start, before) = (w.now, creates(&w));
    w.target("v1.1.0", None);
    w.round();
    assert_eq!(w.outcome().0, "rolled-back");
    // A compromised pool sends a new Update for it at every poll: each lifts the quarantine
    // and gives it a round, which the guard reverts — two recreations of the dispatcher.
    for i in 0..8 {
        w.target("v1.1.0", Some(&format!("wo_{i}")));
        w.poll();
        while w.step() != "idle" {
            w.tick(3);
        }
        w.tick(60);
    }
    assert!(w.now - start < 3600, "{} s", w.now - start);
    // Six in the hour, the first try's included; then the Update waits, unconsumed, with
    // the quarantine kept.
    assert_eq!(creates(&w) - before, 6, "{:?}", w.changes());
    assert_eq!(w.agent.state.brake.count(Ask::Restart, w.now), 6);
    assert!(!w.agent.state.quarantine.is_empty());
    assert!(!w.agent.state.orders.seen("wo_7"));
    assert!(
        w.journal().contains("waits, the quarantine kept: brake: at most 6 restarts of the dispatcher an hour; 6 in the last 60 min"),
        "{}",
        w.journal()
    );
    // An hour after the first try, the Update the pool still sends is taken.
    w.tick(3600);
    w.poll();
    assert!(w.agent.state.orders.seen("wo_7"));
    assert_eq!(
        w.agent
            .state
            .rollout
            .target
            .map(|r| r.to_string())
            .as_deref(),
        Some("v1.1.0")
    );
}

#[test]
fn the_pools_record_of_the_settings_is_taken_only_by_an_agent_without_its_own() {
    let mut w = studio();
    let state = |units: u32| {
        let body = json!({"release": {"target": "v1.0.0"}, "poll_s": 120,
            "settings": {"units": units, "emulate": [foreign(), std::env::consts::ARCH]}});
        Net::Ok(parse_state(body.to_string().as_bytes()).unwrap())
    };
    // None of its own (a state.json lost): the record as the pool says it (the native lane
    // is none to name), narrowed by the envelope — and what the envelope leaves out is said,
    // on the journal and in the next report, for the host page.
    w.pool_answers(state(20));
    w.poll();
    assert_eq!(
        w.agent.state.settings,
        Some(Settings {
            units: Some(20),
            emulate: Some(vec![foreign().to_owned()])
        })
    );
    assert_eq!(capacity(&w)["units"], 8);
    assert!(
        w.journal().contains("taken from the pool's record (this host had none of its own); above the envelope, which leaves it out: units 20 is above the envelope's 8: 8 applies"),
        "{}",
        w.journal()
    );
    settle(&mut w);
    w.tick(600);
    let r = w.last_report();
    assert_eq!(r["settings"]["units"], 20);
    assert_eq!(r["settings"]["effective"]["units"], 8);
    assert_eq!(
        r["settings"]["above"],
        json!(["units 20 is above the envelope's 8: 8 applies"])
    );
    // Its own from then on: the record never changes them.
    w.agent.state.settings = Some(Settings {
        units: Some(3),
        emulate: None,
    });
    w.pool_answers(state(6));
    w.poll();
    assert_eq!(w.agent.state.settings.as_ref().unwrap().units, Some(3));
    assert_eq!(capacity(&w)["units"], 3);
}

/// The report with settings as the pool reads it (`tests/fixtures/host-api/report-settings.json`,
/// which worker/test/host-settings.test.ts posts, signed, and reads back for the host page):
/// a host whose envelope allows 8 of its 11 units and its emulated lane, narrowed to 4 units
/// and no emulated lane. The contract both sides read, written once.
#[test]
fn the_report_with_settings_keeps_the_shape_the_pool_reads() {
    use crate::run::orders::tests::{fixture, shape};
    let mut w = studio();
    w.agent.cfg.policy.emulate = Some(vec![foreign().to_owned()]);
    w.agent.cfg.policy.diagnostics = true;
    for o in [
        json!({"id": format!("ho_{}", "3".repeat(32)), "kind": "set-units", "units": 4}),
        json!({"id": format!("ho_{}", "4".repeat(32)), "kind": "set-emulate", "emulate": []}),
    ] {
        assert_eq!(order(&mut w, &o).0, "done");
    }
    settle(&mut w);
    w.tick(20);
    let r = w.last_report();
    assert_eq!(r["settings"]["units"], 4);
    assert_eq!(r["settings"]["envelope"]["emulate"], json!([foreign()]));
    assert_eq!(
        r["settings"]["envelope"]["detected_lanes"],
        json!([foreign()])
    );
    assert_eq!(r["capacity"]["lanes"].as_array().unwrap().len(), 1);
    assert_eq!(r["brake"]["narrowings_hour"], 2);
    assert_eq!(shape(&r), shape(&fixture("report-settings.json")));
}
