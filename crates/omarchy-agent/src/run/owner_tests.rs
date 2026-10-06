//! #328's acceptance criteria on the agent's side, against the fake engine and pool, with
//! the virtual authenticator's recorded answers (tests/fixtures/owner/cases.json): an owner
//! raises the host's unit cap and sets its agent keys from the browser, with no visit; a
//! widening the pool forged or replayed is refused on the host and answered so; unsealed
//! keys land in `OMARCHY_SECRETS_DIR/agent.env` and nowhere else — not the dispatcher's
//! env, the journal, the report or `state.json`.

use std::fs;
use std::os::unix::fs::PermissionsExt;

use serde_json::Value;

use crate::owner::tests::{cases, fixture_seal, pinned};
use crate::run::fake::World;
use crate::run::pool::{HostState, Net, Order, OrderKind, Signed};

const HOST: &str = "h_0123456789";

/// The Studio's capacity as detection counted it under `max_units = 3`: 12 CPUs and 32 GB
/// give 11 units under the example manifest's constants (1 CPU and 2 GB reserved, 1 CPU and
/// 2 GB a unit); its native lane this machine's.
fn studio() -> String {
    serde_json::json!({
        "schema": 2, "at": "2027-01-15T08:00:00Z", "cpus": 12, "mem_gb": 32, "page_kb": 4,
        "disk_free_gb": {"work": 410, "engine": 220}, "units": 3, "job_reserved": 1, "agent_slots": 2,
        "lanes": [{"arch": std::env::consts::ARCH, "mode": "native"}], "held_lanes": [],
        "isolation": "root", "dedicated": true,
        "limits": {"cpus_hard": true, "memory_hard": true, "pids": true}, "below_minimum": false
    })
    .to_string()
}

/// A host running v1.0.0 that is the fixtures' host, its agent.toml written as install
/// writes it (`max_units = 3`), its capacity the Studio's, the owner's passkey pinned at
/// it (its record at `version`), and its seal key the fixtures'.
fn owned(version: u64) -> World {
    let mut w = World::running_v1();
    w.agent.cfg.host_id = HOST.into();
    let toml = crate::run::config::tests::example(
        &w.set_dir(),
        &w.dir.join("work"),
        &w.dir.join("secrets"),
    )
    .replace("h_test", HOST);
    fs::write(w.agent.paths.agent_toml(), toml).unwrap();
    fs::set_permissions(
        w.agent.paths.agent_toml(),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::write(w.set_dir().join("run/capacity.json"), studio()).unwrap();
    settle(&mut w);
    fs::create_dir_all(w.dir.join("secrets")).unwrap();
    fs::set_permissions(w.dir.join("secrets"), fs::Permissions::from_mode(0o700)).unwrap();
    let state = w.agent.paths.data.join("state");
    let pin_state = pinned("es256", version);
    fs::create_dir_all(&state).unwrap();
    fs::copy(pin_state.join("owner.json"), state.join("owner.json")).unwrap();
    fixture_seal(&state);
    w.agent.seal = None;
    w
}

/// The host state now carries `orders`: (id, the order as the pool sends it).
fn send(w: &World, orders: &[(&str, OrderKind)]) {
    let now = w.now;
    let mut r = w.remote.borrow_mut();
    let mut s = match r.state.take() {
        Some(Net::Ok(s)) => s,
        _ => HostState::default(),
    };
    s.orders = orders
        .iter()
        .map(|(id, kind)| Order {
            id: (*id).into(),
            kind: kind.clone(),
            not_after: Some(now + 3600),
        })
        .collect();
    r.state = Some(Net::Ok(s));
}

fn signed(case: &Value) -> Signed {
    Signed {
        doc: case["doc"].as_str().unwrap().to_owned(),
        assertion: serde_json::from_value(case["assertion"].clone()).unwrap(),
    }
}

fn widen(case: &Value) -> OrderKind {
    OrderKind::WidenEnvelope(Some(signed(case)))
}

fn answer(w: &World, id: &str) -> (String, String) {
    let a = w
        .agent
        .state
        .orders
        .answers
        .iter()
        .find(|a| a.id == id)
        .unwrap_or_else(|| panic!("{id} was not answered"));
    (a.outcome.clone(), a.detail.clone())
}

fn capacity(w: &World) -> Value {
    serde_json::from_slice(&fs::read(w.set_dir().join("run/capacity.json")).unwrap()).unwrap()
}

#[test]
fn an_owner_raises_the_unit_cap_from_the_browser_and_a_forged_or_replayed_widening_is_refused() {
    let c = cases();
    let mut w = owned(1);
    let before = dispatcher_id(&w);
    send(&w, &[("ho_w1", widen(&c["widen"]))]);
    w.poll();
    let (outcome, detail) = answer(&w, "ho_w1");
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        detail.starts_with("m1's passkey widened the envelope (version 2): max_units 3 → 8"),
        "{detail}"
    );
    assert!(detail.contains("units 3 → 8"), "{detail}");
    let toml = fs::read_to_string(w.agent.paths.agent_toml()).unwrap();
    assert!(toml.contains("max_units = 8\n"), "{toml}");
    // The owner's file keeps its mode and its other lines.
    assert_eq!(
        fs::metadata(w.agent.paths.agent_toml())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(toml.contains("rootful_ack = true"));
    // The loop took it at once, and counted the units again under the signed constants.
    assert_eq!(w.agent.cfg.policy.max_units, Some(8));
    let f = capacity(&w);
    assert_eq!(
        (f["units"].as_u64(), f["job_reserved"].as_u64()),
        (Some(8), Some(1))
    );
    let r = crate::owner::Record::load(&w.agent.paths.data.join("state")).unwrap();
    assert_eq!(r.version, 2);
    // The changed run/capacity.json recreates the dispatcher (an input of the set).
    settle(&mut w);
    assert_ne!(dispatcher_id(&w), before);
    // The report says the new envelope and the answer.
    w.tick(20);
    let rep = w.last_report();
    assert_eq!(rep["owner"]["envelope"]["max_units"], 8);
    assert_eq!(rep["owner"]["version"], 2);
    assert_eq!(rep["owner"]["passkey"]["alg"], "ES256");
    assert!(rep["orders"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["id"] == "ho_w1" && a["outcome"] == "done"));

    // The same document again, under a new order: a replay, refused with nothing changed.
    send(&w, &[("ho_w2", widen(&c["widen"]))]);
    w.poll();
    let (outcome, detail) = answer(&w, "ho_w2");
    assert_eq!(outcome, "refused");
    assert!(
        detail.contains("not above the last this host took (2): a replay"),
        "{detail}"
    );
    // A lower version, signed by the owner's passkey: refused.
    w.tick(3);
    send(&w, &[("ho_w3", widen(&c["widen_lower"]))]);
    w.poll();
    let (outcome, detail) = answer(&w, "ho_w3");
    assert_eq!(outcome, "refused");
    assert!(detail.contains("its version 1 is not above"), "{detail}");
    assert!(fs::read_to_string(w.agent.paths.agent_toml())
        .unwrap()
        .contains("max_units = 8\n"));
    assert_eq!(capacity(&w)["units"], 8);
}

/// The agent stopped after a widening's change, before its answer reached the pool: the
/// same order comes back unremembered, and is answered as taken already — not as a replay
/// of a change that took effect —, nothing changed again. The same document under another
/// order stays a replay.
#[test]
fn the_same_order_seen_again_after_its_change_is_taken_already_not_a_replay() {
    let c = cases();
    let mut w = owned(1);
    send(&w, &[("ho_w1", widen(&c["widen"]))]);
    w.poll();
    assert_eq!(answer(&w, "ho_w1").0, "done");
    let toml = fs::read_to_string(w.agent.paths.agent_toml()).unwrap();
    // As after a restart from a state.json saved before the answer.
    w.agent.state.orders.seen.clear();
    w.agent.state.orders.answers.clear();
    w.tick(3);
    send(&w, &[("ho_w1", widen(&c["widen"]))]);
    w.poll();
    let (outcome, detail) = answer(&w, "ho_w1");
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        detail.contains("(version 2) was taken already: nothing changed again"),
        "{detail}"
    );
    assert_eq!(
        fs::read_to_string(w.agent.paths.agent_toml()).unwrap(),
        toml
    );
    w.tick(3);
    send(&w, &[("ho_w9", widen(&c["widen"]))]);
    w.poll();
    let (outcome, detail) = answer(&w, "ho_w9");
    assert_eq!(outcome, "refused");
    assert!(detail.contains("a replay"), "{detail}");
}

/// What can refuse a widening is checked before anything changes: a `run/capacity.json`
/// that does not read (a link, never followed) refuses it with agent.toml and the
/// version as they were, so the owner's next document is taken.
#[test]
fn a_capacity_file_that_does_not_read_refuses_the_widening_before_anything_changes() {
    let c = cases();
    let mut w = owned(1);
    let toml = fs::read_to_string(w.agent.paths.agent_toml()).unwrap();
    let file = w.set_dir().join("run/capacity.json");
    let aside = w.dir.join("capacity.json");
    fs::rename(&file, &aside).unwrap();
    std::os::unix::fs::symlink(&aside, &file).unwrap();
    send(&w, &[("ho_w1", widen(&c["widen"]))]);
    w.poll();
    let (outcome, detail) = answer(&w, "ho_w1");
    assert_eq!(outcome, "refused");
    assert!(
        detail.contains("is a symbolic link; not followed"),
        "{detail}"
    );
    assert_eq!(
        fs::read_to_string(w.agent.paths.agent_toml()).unwrap(),
        toml
    );
    assert_eq!(w.agent.cfg.policy.max_units, Some(3));
    let r = crate::owner::Record::load(&w.agent.paths.data.join("state")).unwrap();
    assert_eq!((r.version, r.taken), (1, None));
}

#[test]
fn every_widening_the_pool_could_forge_is_refused_and_reported() {
    let c = cases();
    let refused = c["refused"].as_array().unwrap();
    let mut w = owned(1);
    let toml = fs::read_to_string(w.agent.paths.agent_toml()).unwrap();
    for (i, r) in refused.iter().enumerate() {
        let id = format!("ho_r{i}");
        send(&w, &[(&id, widen(r))]);
        w.poll();
        let (outcome, detail) = answer(&w, &id);
        assert_eq!(outcome, "refused", "{}", r["why"]);
        assert!(
            detail.contains(r["says"].as_str().unwrap()),
            "{}: {detail}",
            r["why"]
        );
        w.tick(3);
    }
    // No assertion at all: the order carries no signed document.
    send(&w, &[("ho_none", OrderKind::WidenEnvelope(None))]);
    w.poll();
    let (outcome, detail) = answer(&w, "ho_none");
    assert_eq!(outcome, "refused");
    assert!(
        detail.contains("no document the owner's passkey signed"),
        "{detail}"
    );
    // Nothing changed: agent.toml, the capacity, the record's version.
    assert_eq!(
        fs::read_to_string(w.agent.paths.agent_toml()).unwrap(),
        toml
    );
    assert_eq!(capacity(&w)["units"], 3);
    assert_eq!(
        crate::owner::Record::load(&w.agent.paths.data.join("state"))
            .unwrap()
            .version,
        1
    );
    // The report carries the last answers, each a refusal with why, which the pool shows on
    // the host page.
    w.tick(20);
    let rep = w.last_report();
    let answers = rep["orders"].as_array().unwrap();
    assert!(answers.iter().all(|a| a["outcome"] == "refused"), "{rep}");
    assert!(answers.iter().any(|a| a["id"] == "ho_none"), "{rep}");

    // With no passkey pinned at all, the owner is told how to pin one.
    let state = w.agent.paths.data.join("state");
    crate::owner::unpin(&state).unwrap();
    w.tick(3);
    send(&w, &[("ho_unpinned", widen(&c["widen"]))]);
    w.poll();
    let (outcome, detail) = answer(&w, "ho_unpinned");
    assert_eq!(outcome, "refused");
    assert!(
        detail.contains("omarchy-agent envelope pin-passkey"),
        "{detail}"
    );
}

#[test]
fn a_widening_never_gives_more_units_than_the_constants_and_the_hardware() {
    let c = cases();
    let mut w = owned(1);
    // The owner's widening asks for 8; a host whose detection found 12 CPUs and 32 GB gives
    // at most 11 under the signed constants, and a cap above that gives 11, never more.
    let doc = c["widen"]["doc"].as_str().unwrap();
    assert!(doc.contains("\"max_units\":8"));
    send(&w, &[("ho_w1", widen(&c["widen"]))]);
    w.poll();
    assert_eq!(capacity(&w)["units"], 8);
    let caps = crate::capacity::Caps {
        max_units: Some(4096),
        ..crate::capacity::Caps::default()
    };
    let b = w.agent.cached(w.agent.state.applied.unwrap()).unwrap();
    // Counted again with no envelope and no setting narrowing it: what the caps give alone.
    let open = crate::run::config::Policy::default();
    let rewrite = |caps: &crate::capacity::Caps, s: &crate::run::settings::Settings| {
        let r = crate::run::settings::recount(
            &w.set_dir(),
            caps,
            b.manifest().capacity().constants(),
            s,
            &open,
        )
        .unwrap();
        r.write(&w.set_dir()).unwrap();
        r.changes
    };
    let none = crate::run::settings::Settings::default();
    rewrite(&caps, &none);
    assert_eq!(capacity(&w)["units"], 11);
    // max_cpus above what detection found counts no CPU that is not there.
    let caps = crate::capacity::Caps {
        max_cpus: Some(64),
        ..caps
    };
    let base = crate::run::settings::Base::read(&w.set_dir())
        .unwrap()
        .unwrap();
    assert!(base
        .recapped(&caps, b.manifest().capacity().constants())
        .is_none());
    // A cap below what detection found keeps the hardware's totals beside the capped ones,
    // so a later widening counts from them again.
    let caps = crate::capacity::Caps {
        max_cpus: Some(6),
        ..caps
    };
    let changes = rewrite(&caps, &none);
    assert_eq!(changes, ["cpus 12 → 6", "units 11 → 5"]);
    let f = capacity(&w);
    assert_eq!(
        (f["cpus"].as_u64(), f["units"].as_u64()),
        (Some(6), Some(5))
    );
    assert_eq!(f["hardware"], serde_json::json!({"cpus": 12, "mem_gb": 32}));
    let caps = crate::capacity::Caps {
        max_cpus: None,
        ..caps
    };
    rewrite(&caps, &none);
    let f = capacity(&w);
    assert_eq!(
        (f["cpus"].as_u64(), f["units"].as_u64()),
        (Some(12), Some(11))
    );
    assert!(f.get("hardware").is_none());
    // Under a setting, the count is written narrowed at once — the file the dispatcher reads
    // never holds the recounted units above the pool's narrowing, even for a moment — with
    // detection's own count beside it, for a later setting to start from.
    let caps = crate::capacity::Caps {
        max_cpus: Some(6),
        ..caps
    };
    let changes = rewrite(
        &caps,
        &crate::run::settings::Settings {
            units: Some(3),
            emulate: None,
        },
    );
    assert_eq!(changes, ["cpus 12 → 6", "units 11 → 5"]);
    let f = capacity(&w);
    assert_eq!(
        (f["cpus"].as_u64(), f["units"].as_u64()),
        (Some(6), Some(3))
    );
    assert_eq!(f["detected"]["units"], 5);
}

#[test]
fn sealed_agent_keys_land_in_agent_env_alone() {
    let c = cases();
    let mut w = owned(2);
    // The owner's own line, and a key the document takes out.
    let env = w.dir.join("secrets/agent.env");
    fs::write(
        &env,
        "# mine\nGEMINI_API_KEY=keep-this-one\nOPENAI_API_KEY=sk-old\n",
    )
    .unwrap();
    fs::set_permissions(&env, fs::Permissions::from_mode(0o600)).unwrap();
    send(
        &w,
        &[("ho_k1", OrderKind::SetAgentKeys(Some(signed(&c["keys"]))))],
    );
    w.poll();
    let (outcome, detail) = answer(&w, "ho_k1");
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        detail.starts_with("m1's passkey (version 3): CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN set, OPENAI_API_KEY taken out in "),
        "{detail}"
    );
    let canary = c["keys"]["values"]["CLAUDE_CODE_OAUTH_TOKEN"]
        .as_str()
        .unwrap();
    let token = c["keys"]["values"]["GITHUB_TOKEN"].as_str().unwrap();
    let text = fs::read_to_string(&env).unwrap();
    assert_eq!(
        text,
        format!("# mine\nGEMINI_API_KEY=keep-this-one\nCLAUDE_CODE_OAUTH_TOKEN={canary}\nGITHUB_TOKEN={token}\n")
    );
    assert_eq!(
        fs::metadata(&env).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // The GITHUB_TOKEN was asked of GitHub (public read only) before anything was written.
    assert_eq!(w.remote.borrow().scopes_asked, 1);
    // Nowhere else: not the dispatcher's env, the journal, the report, state.json, the
    // owner's record — and not the bundle's rendered files.
    w.tick(20);
    let report = w.last_report().to_string();
    assert!(
        report.contains("CLAUDE_CODE_OAUTH_TOKEN"),
        "the names ride the report"
    );
    let mut places = vec![
        ("the report".to_owned(), report),
        ("the journal".to_owned(), w.journal()),
        (
            "state.json".to_owned(),
            fs::read_to_string(w.agent.paths.state()).unwrap(),
        ),
        (
            "owner.json".to_owned(),
            fs::read_to_string(w.agent.paths.data.join("state/owner.json")).unwrap(),
        ),
    ];
    for e in walk(&w.set_dir()) {
        places.push((
            e.display().to_string(),
            fs::read_to_string(&e).unwrap_or_default(),
        ));
    }
    for (what, text) in &places {
        assert!(!text.contains(canary), "{what} carries the sealed key");
        assert!(!text.contains(token), "{what} carries the sealed token");
    }
    let rep = w.last_report();
    assert_eq!(
        rep["owner"]["agent_keys"],
        serde_json::json!(["GEMINI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN"])
    );
    assert_eq!(rep["owner"]["seal"]["key"], c["seal"]["public"]);
    // The owner's part of the report, as the pool reads it (tests/fixtures/host-api/
    // report-owner.json, which worker/test/host-owner.test.ts posts, signed): the pinned
    // passkey, the seal key, the version, the keys' names, and the envelope's keys a widening
    // sets.
    let fixture = crate::run::orders::tests::fixture("report-owner.json");
    let o = &rep["owner"];
    for k in ["passkey", "seal", "version", "agent_keys"] {
        assert_eq!(
            crate::run::orders::tests::shape(&o[k]),
            crate::run::orders::tests::shape(&fixture["owner"][k]),
            "{k}"
        );
    }
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(&o["envelope"]), keys(&fixture["owner"]["envelope"]));
    assert_eq!(keys(o), keys(&fixture["owner"]));
    // The journal scrubs the values from now on, whatever echoes them.
    assert_eq!(
        w.agent.journal.scrub(&format!("an engine said {canary}")),
        "an engine said [redacted]"
    );
    // The same document again: a replay.
    send(
        &w,
        &[("ho_k2", OrderKind::SetAgentKeys(Some(signed(&c["keys"]))))],
    );
    w.poll();
    assert!(answer(&w, "ho_k2").1.contains("a replay"));
}

#[test]
fn a_github_token_with_a_scope_or_a_key_not_for_this_host_is_refused_with_nothing_written() {
    let c = cases();
    let mut w = owned(2);
    w.remote.borrow_mut().scopes = Some(Net::Ok(Some("repo, workflow".into())));
    send(
        &w,
        &[("ho_k1", OrderKind::SetAgentKeys(Some(signed(&c["keys"]))))],
    );
    w.poll();
    let (outcome, detail) = answer(&w, "ho_k1");
    assert_eq!(outcome, "refused");
    assert!(
        detail.contains("GITHUB_TOKEN carries the scopes repo, workflow"),
        "{detail}"
    );
    assert!(!w.dir.join("secrets/agent.env").exists());
    // Not taken: the owner signs it again once the token is public read only.
    assert_eq!(
        crate::owner::Record::load(&w.agent.paths.data.join("state"))
            .unwrap()
            .version,
        2
    );
    for (i, r) in c["keys_refused"].as_array().unwrap().iter().enumerate() {
        w.tick(3);
        let id = format!("ho_kr{i}");
        send(&w, &[(&id, OrderKind::SetAgentKeys(Some(signed(r))))]);
        w.poll();
        let (outcome, detail) = answer(&w, &id);
        assert_eq!(outcome, "refused", "{}", r["why"]);
        assert!(
            detail.contains(r["says"].as_str().unwrap()),
            "{}: {detail}",
            r["why"]
        );
    }
    assert!(!w.dir.join("secrets/agent.env").exists());
    // A widening's signature sets no key, and the reverse.
    w.tick(3);
    send(
        &w,
        &[("ho_x", OrderKind::SetAgentKeys(Some(signed(&c["widen"]))))],
    );
    w.poll();
    assert!(answer(&w, "ho_x").1.contains("not set-agent-keys"));
}

#[test]
fn the_host_state_carries_the_signed_document_as_the_pool_relays_it() {
    let c = cases();
    let body = serde_json::json!({
        "release": {"target": "v1.0.0"},
        "orders": [
            {"id": "ho_1", "kind": "widen-envelope", "not_after": "2027-01-15T09:00:00.000Z", "version": 2,
             "doc": c["widen"]["doc"], "assertion": c["widen"]["assertion"]},
            {"id": "ho_2", "kind": "set-agent-keys", "not_after": "2027-01-15T09:00:00.000Z", "doc": c["keys"]["doc"]},
            {"id": "ho_3", "kind": "widen-envelope", "not_after": "2027-01-15T09:00:00.000Z", "doc": 7, "assertion": {}},
        ],
    });
    let s = crate::run::pool::parse_state(body.to_string().as_bytes()).unwrap();
    assert_eq!(s.orders[0].kind, widen(&c["widen"]));
    assert_eq!(s.orders[1].kind, OrderKind::SetAgentKeys(None));
    assert_eq!(s.orders[2].kind, OrderKind::WidenEnvelope(None));
    assert_eq!(s.orders[0].kind.name(), "widen-envelope");
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

fn dispatcher_id(w: &World) -> String {
    w.engine.borrow().dispatcher().unwrap().id.clone()
}

/// Every file under `dir`.
fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

#[test]
fn an_agent_env_that_is_a_link_is_refused_and_not_followed() {
    let c = cases();
    let mut w = owned(2);
    let elsewhere = w.dir.join("elsewhere.env");
    fs::write(&elsewhere, "KEEP=1\n").unwrap();
    std::os::unix::fs::symlink(&elsewhere, w.dir.join("secrets/agent.env")).unwrap();
    send(
        &w,
        &[("ho_link", OrderKind::SetAgentKeys(Some(signed(&c["keys"]))))],
    );
    w.poll();
    let (outcome, detail) = answer(&w, "ho_link");
    assert_eq!(outcome, "refused");
    assert!(
        detail.ends_with("agent.env: a symbolic link; refused, not followed"),
        "{detail}"
    );
    assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "KEEP=1\n");
    // Nothing taken: the owner signs it again once the link is gone.
    assert_eq!(
        crate::owner::Record::load(&w.agent.paths.data.join("state"))
            .unwrap()
            .version,
        2
    );
}
