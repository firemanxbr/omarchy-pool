//! #328's checks on the host, against the recorded answers of the virtual authenticator
//! (tests/fixtures/owner/cases.json, made by tests/owner-fixtures.mjs): the pin, each way a
//! document the pool forged or replayed is refused, the widening's keys and agent.toml's
//! lines, the sealed keys opened and `agent.env` merged.

use std::fs;
use std::os::unix::fs::PermissionsExt;

use serde_json::Value;

use super::seal::{SealKey, Sealed};
use super::*;

pub(crate) const CASES: &str = include_str!("../../tests/fixtures/owner/cases.json");
/// The tests' clock: 2027-01-15T08:00:00Z (`run::fake::T0`), inside every fixture's life.
pub(crate) const NOW: i64 = 1_800_000_000;
const HOST: &str = "h_0123456789";
const POOL: &str = "https://pkgs.omarchy-pool.org";

pub(crate) fn cases() -> Value {
    serde_json::from_str(CASES).unwrap()
}

pub(crate) fn assertion(v: &Value) -> Assertion {
    serde_json::from_value(v.clone()).unwrap()
}

/// A state directory with the owner's ES256 passkey pinned (the fixture's pin), and its
/// record at `version`.
pub(crate) fn pinned(pin_name: &str, version: u64) -> std::path::PathBuf {
    let state = crate::run::state::tempdir().join("state");
    let c = cases();
    pin(
        &state,
        HOST,
        POOL,
        c["pins"][pin_name].as_str().unwrap(),
        NOW,
    )
    .unwrap();
    let mut r = Record::load(&state).unwrap();
    r.version = version;
    r.save(&state).unwrap();
    state
}

/// The fixture's seal key, as the host keeps it.
pub(crate) fn fixture_seal(state: &std::path::Path) -> SealKey {
    let c = cases();
    let private = webauthn::unb64(c["seal"]["private"].as_str().unwrap(), "", 64).unwrap();
    fs::create_dir_all(state).unwrap();
    crate::host::replace(&state.join(seal::KEY_FILE), &private).unwrap();
    SealKey::load_or_create(state).unwrap()
}

#[test]
fn a_pin_takes_the_owners_passkey_for_this_host_and_its_relying_party() {
    let state = crate::run::state::tempdir().join("state");
    let c = cases();
    let said = pin(
        &state,
        HOST,
        POOL,
        c["pins"]["es256"].as_str().unwrap(),
        NOW,
    )
    .unwrap();
    assert!(
        said.starts_with("pinned m1's passkey (ES256, credential "),
        "{said}"
    );
    let r = Record::load(&state).unwrap();
    let p = r.passkey.unwrap();
    assert_eq!(
        (p.host.as_str(), p.rp_id.as_str(), p.origin.as_str(), p.alg),
        (
            HOST,
            "omarchy-pool.org",
            "https://omarchy-pool.org",
            webauthn::ES256
        )
    );
    assert_eq!(
        p.credential,
        c["widen"]["assertion"]["credential"].as_str().unwrap()
    );
    assert!(p.counter > 0);
    // 0600, beside the host key.
    assert_eq!(
        fs::metadata(state.join(RECORD_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    // Pasted with the line's spaces and a newline, as a terminal gives it.
    let text = format!("  {}\n", c["pins"]["eddsa"].as_str().unwrap());
    let said = pin(&state, HOST, POOL, &text, NOW).unwrap();
    assert!(
        said.contains("EdDSA") && said.contains("it replaces"),
        "{said}"
    );
    // A version taken survives a new pin and an unpin: nothing signed before comes back.
    let mut r = Record::load(&state).unwrap();
    r.version = 7;
    r.save(&state).unwrap();
    pin(
        &state,
        HOST,
        POOL,
        c["pins"]["rs256"].as_str().unwrap(),
        NOW,
    )
    .unwrap();
    assert_eq!(Record::load(&state).unwrap().version, 7);
    assert!(unpin(&state).unwrap().starts_with("unpinned m1's passkey"));
    let r = Record::load(&state).unwrap();
    assert_eq!((r.version, r.passkey), (7, None));
    assert_eq!(unpin(&state).unwrap(), "no passkey was pinned here");
}

#[test]
fn a_pin_for_another_host_another_pool_too_late_or_not_the_keys_is_refused() {
    let state = crate::run::state::tempdir().join("state");
    let c = cases();
    let p = |name: &str| c["pins"][name].as_str().unwrap().to_owned();
    for (text, host, pool, now, says) in [
        (p("other_host"), HOST, POOL, NOW, "for host h_9999999999"),
        (
            p("es256"),
            "h_9999999999",
            POOL,
            NOW,
            "not this one (h_9999999999)",
        ),
        (
            p("es256"),
            HOST,
            "https://pool.example.org",
            NOW,
            "not this host's pool",
        ),
        (p("es256"), HOST, POOL, NOW + 3600, "expired at"),
        (p("no_uv"), HOST, POOL, NOW, "did not verify the user"),
        (
            p("other_key"),
            HOST,
            POOL,
            NOW,
            "is not the pinned passkey's",
        ),
        ("not a pin".to_owned(), HOST, POOL, NOW, "copy it again"),
        (webauthn::b64(b"{}"), HOST, POOL, NOW, "does not read"),
    ] {
        let e = pin(&state, host, pool, &text, now).unwrap_err();
        assert!(e.contains(says), "{says}: {e}");
    }
    assert_eq!(Record::load(&state).unwrap(), Record::default());
}

#[test]
fn the_relying_party_is_the_pools_own_domain_or_localhost() {
    for (pool, rp, origin, ok) in [
        (POOL, "omarchy-pool.org", "https://omarchy-pool.org", true),
        (
            POOL,
            "pkgs.omarchy-pool.org",
            "https://pkgs.omarchy-pool.org",
            true,
        ),
        (POOL, "omarchy-pool.org", "http://omarchy-pool.org", false),
        (POOL, "evil.example", "https://evil.example", false),
        (POOL, "pool.org", "https://pool.org", false),
        (POOL, "org", "https://org", false),
        (
            "http://127.0.0.1:8793",
            "localhost",
            "http://localhost:8793",
            true,
        ),
        (
            "http://127.0.0.1:8793",
            "localhost",
            "http://localhost:x",
            false,
        ),
        (
            "http://localhost:8787",
            "localhost",
            "http://localhost:8787",
            true,
        ),
        (
            "http://[::1]:8787",
            "localhost",
            "http://localhost:8787",
            true,
        ),
        // A pool not on this machine never takes a localhost relying party.
        (POOL, "localhost", "http://localhost:8787", false),
        (POOL, "localhost", "https://localhost", false),
        (
            "http://[::2]:8787",
            "localhost",
            "http://localhost:8787",
            false,
        ),
        (
            "http://localhost.evil.example",
            "localhost",
            "http://localhost",
            false,
        ),
    ] {
        assert_eq!(
            relying_party_ok(pool, rp, origin),
            ok,
            "{pool} {rp} {origin}"
        );
    }
}

#[test]
fn the_owners_widening_verifies_with_the_pinned_passkey_once() {
    let c = cases();
    for (pin_name, case) in [
        ("es256", "widen"),
        ("eddsa", "widen_eddsa"),
        ("rs256", "widen_rs256"),
    ] {
        let state = pinned(pin_name, 1);
        let rec = Record::load(&state).unwrap();
        let doc = c[case]["doc"].as_str().unwrap();
        let (d, counter) = verify_signed(
            &rec,
            doc.as_bytes(),
            &assertion(&c[case]["assertion"]),
            Act::WidenEnvelope,
            HOST,
            NOW,
        )
        .unwrap_or_else(|e| panic!("{case}: {e}"));
        assert_eq!((d.version, d.by.as_str()), (Some(2), "m1"));
        assert_eq!(d.envelope.unwrap()["max_units"], 8);
        // EdDSA's virtual authenticator keeps no counter, as synced passkeys do.
        assert_eq!(counter == 0, pin_name == "eddsa", "{case}");
    }
}

#[test]
fn a_widening_the_pool_forged_or_replayed_is_refused() {
    let c = cases();
    let state = pinned("es256", 1);
    let mut rec = Record::load(&state).unwrap();
    let check = |rec: &Record, case: &Value, act: Act, now: i64| {
        verify_signed(
            rec,
            case["doc"].as_str().unwrap().as_bytes(),
            &assertion(&case["assertion"]),
            act,
            HOST,
            now,
        )
    };
    for r in c["refused"].as_array().unwrap() {
        let e = check(&rec, r, Act::WidenEnvelope, NOW)
            .map(|(d, _)| Widening::read(d.envelope.as_ref().unwrap()).map(|_| ()))
            .and_then(|w| w)
            .unwrap_err();
        assert!(e.contains(r["says"].as_str().unwrap()), "{}: {e}", r["why"]);
    }
    // No assertion at all: nothing to check it with.
    let mut none = assertion(&c["widen"]["assertion"]);
    none.client_data.clear();
    none.authenticator_data.clear();
    none.signature.clear();
    assert!(check_with(&rec, &c["widen"], &none).contains("clientDataJSON is missing"));
    // Another act's document: a widening's signature does not set keys.
    assert!(check(&rec, &c["widen"], Act::SetAgentKeys, NOW)
        .unwrap_err()
        .contains("signs \"widen-envelope\", not set-agent-keys"));
    // Taken once: the version moves, and the same document again is a replay.
    let (d, counter) = check(&rec, &c["widen"], Act::WidenEnvelope, NOW).unwrap();
    rec.version = d.version.unwrap();
    rec.passkey.as_mut().unwrap().counter = counter;
    let e = check(&rec, &c["widen"], Act::WidenEnvelope, NOW).unwrap_err();
    assert!(
        e.contains("its version 2 is not above the last this host took (2): a replay"),
        "{e}"
    );
    // A lower version, signed properly, is an older document.
    let e = check(&rec, &c["widen_lower"], Act::WidenEnvelope, NOW).unwrap_err();
    assert!(e.contains("its version 1 is not above"), "{e}");
    // Past its not_after, by the host's clock.
    assert!(check(
        &pinned_record(),
        &c["widen"],
        Act::WidenEnvelope,
        NOW + 3600
    )
    .unwrap_err()
    .contains("expired at 2027-01-15T08:55:00.000Z"));
    // A counter that did not move: a copy of the key.
    let mut cloned = pinned_record();
    cloned.passkey.as_mut().unwrap().counter = 1000;
    assert!(check(&cloned, &c["widen"], Act::WidenEnvelope, NOW)
        .unwrap_err()
        .contains("a copy of the key may be in use"));
    // Nothing pinned: refused, saying how to pin.
    assert!(
        check(&Record::default(), &c["widen"], Act::WidenEnvelope, NOW)
            .unwrap_err()
            .contains("omarchy-agent envelope pin-passkey")
    );
}

fn pinned_record() -> Record {
    Record::load(&pinned("es256", 1)).unwrap()
}

fn check_with(rec: &Record, case: &Value, a: &Assertion) -> String {
    verify_signed(
        rec,
        case["doc"].as_str().unwrap().as_bytes(),
        a,
        Act::WidenEnvelope,
        HOST,
        NOW,
    )
    .unwrap_err()
}

#[test]
#[allow(clippy::too_many_lines)] // one widening, each key's bounds and the file it lands in
fn a_widening_sets_only_the_keys_it_may_and_keeps_the_owners_lines() {
    let env = |v: Value| Widening::read(v.as_object().unwrap());
    let text = "# The agent's envelope: written by install and by a person at this host.\npool = \"https://pkgs.omarchy-pool.org\"\nhost_id = \"h_0123456789\"\nworker_id = \"m1-test-0a9z\"\n[set]\ndir = \"/srv/set\"\nwork_root = \"/srv/work\"\nsecrets_dir = \"/srv/secrets\"\nsocket_cli = \"/var/run/docker.sock\"\n[envelope]\n# three units while the canary runs (the owner's note)\nmax_units = 3\nallow_socket = true\nrootful_ack = true\ndedicated = true\nemulate = []\ndiagnostics = false\n";
    let w = env(serde_json::json!({"max_units": 8, "emulate": ["x86_64"], "diagnostics": true, "agent_budget": {"calls_per_day": 9000}})).unwrap();
    let (new, changes) = w.apply(text).unwrap();
    assert!(
        new.contains("# three units while the canary runs (the owner's note)\nmax_units = 8\n"),
        "{new}"
    );
    assert!(new.starts_with("# The agent's envelope"));
    assert!(new.contains("emulate = [\"x86_64\"]") && new.contains("diagnostics = true"));
    assert!(
        new.contains("agent_budget = { calls_per_day = 9000 }"),
        "{new}"
    );
    assert_eq!(
        changes,
        [
            "agent_budget none → { calls_per_day = 9000 }",
            "diagnostics false → true",
            "emulate [] → [\"x86_64\"]",
            "max_units 3 → 8",
        ]
    );
    let cfg = crate::run::config::Config::parse(&new).unwrap();
    assert_eq!(cfg.policy.max_units, Some(8));
    assert!(cfg.policy.diagnostics);
    // null takes a cap out: the detected count decides.
    let (new, _) = env(serde_json::json!({"max_units": null}))
        .unwrap()
        .apply(text)
        .unwrap();
    assert!(!new.contains("max_units"), "{new}");
    // A budget the owner wrote as a table of its own is written again from the table.
    let table = format!("{text}[envelope.agent_budget]\ncalls_per_task = 50\n");
    let (new, _) = env(serde_json::json!({"agent_budget": {"calls_per_day": 9000}}))
        .unwrap()
        .apply(&table)
        .unwrap();
    assert_eq!(
        crate::run::config::Config::parse(&new)
            .unwrap()
            .agent_budget
            .calls_per_day,
        Some(9000)
    );
    for (v, says) in [
        (serde_json::json!({}), "names no key"),
        (
            serde_json::json!({"allow_socket": true}),
            "\"allow_socket\" is no key",
        ),
        (
            serde_json::json!({"soak_minutes": 0}),
            "\"soak_minutes\" is no key",
        ),
        (
            serde_json::json!({"task_subnets": "10.0.0.0/8"}),
            "\"task_subnets\" is no key",
        ),
        // #373's grant of a signed exception's bridge stays the host's.
        (
            serde_json::json!({"direct_network": true}),
            "\"direct_network\" is no key",
        ),
        // So does #330's sandboxed runtime: a widening never turns it off or names another.
        (
            serde_json::json!({"sandbox": "off"}),
            "\"sandbox\" is no key",
        ),
        (
            serde_json::json!({"max_units": 0}),
            "max_units: a whole number from 1",
        ),
        (
            serde_json::json!({"max_units": 5000}),
            "max_units: a whole number from 1 to 4096",
        ),
        (
            serde_json::json!({"emulate": ["riscv64"]}),
            "distinct architectures",
        ),
        (
            serde_json::json!({"emulate": ["x86_64", "x86_64"]}),
            "distinct architectures",
        ),
        (serde_json::json!({"diagnostics": "yes"}), "true or false"),
        (
            serde_json::json!({"diagnostics": null}),
            "null is not a value",
        ),
        (
            serde_json::json!({"agent_budget": {"calls_per_day": 0}}),
            "agent_budget.calls_per_day",
        ),
        (
            serde_json::json!({"agent_budget": {"calls_per_hour": 9}}),
            "calls_per_hour",
        ),
        (serde_json::json!({"paths": ["/"]}), "below /"),
        (serde_json::json!({"paths": ["relative"]}), "plain absolute"),
        (
            serde_json::json!({"paths": ["/srv/../etc"]}),
            "plain absolute",
        ),
    ] {
        let e = env(v.clone()).unwrap_err();
        assert!(e.contains(says), "{v}: {says}: {e}");
    }
    // A value the agent would refuse its own configuration for is refused before it is
    // written: a Mac's VM takes its size from max_cpus.
    let mac = include_str!("../../tests/fixtures/lint/envelope/mac.toml");
    let mac = format!("worker_id = \"w_1\"\n{mac}");
    let e = env(serde_json::json!({"max_cpus": null}))
        .unwrap()
        .apply(&mac)
        .unwrap_err();
    assert!(e.contains("takes its size"), "{e}");
    // The report's view of the envelope: the keys a widening sets, as agent.toml says them.
    let v = envelope_view(text);
    assert_eq!(
        (v["max_units"].clone(), v["emulate"].clone()),
        (3.into(), serde_json::json!([]))
    );
    assert_eq!(v["agent_budget"], Value::Null);
}

#[test]
#[allow(clippy::too_many_lines)] // one sealed key, each way it is refused, and the file it lands in
fn sealed_keys_open_only_for_this_host_and_name_and_merge_into_agent_env() {
    let c = cases();
    let state = crate::run::state::tempdir().join("state");
    let seal = fixture_seal(&state);
    assert_eq!(seal.public_b64u(), c["seal"]["public"].as_str().unwrap());
    let doc: Doc = serde_json::from_str(c["keys"]["doc"].as_str().unwrap()).unwrap();
    let keys = open_keys(&seal, HOST, &doc).unwrap();
    assert_eq!(
        keys,
        [
            (
                "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
                Some(
                    c["keys"]["values"]["CLAUDE_CODE_OAUTH_TOKEN"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                )
            ),
            (
                "GITHUB_TOKEN".to_owned(),
                Some(
                    c["keys"]["values"]["GITHUB_TOKEN"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                )
            ),
            ("OPENAI_API_KEY".to_owned(), None),
        ]
    );
    for r in c["keys_refused"].as_array().unwrap() {
        let doc: Doc = serde_json::from_str(r["doc"].as_str().unwrap()).unwrap();
        let e = open_keys(&seal, HOST, &doc).unwrap_err();
        assert!(e.contains(r["says"].as_str().unwrap()), "{}: {e}", r["why"]);
    }
    // A value sealed here opens; a byte changed on the way does not.
    let mut s = seal::seal(
        &webauthn::unb64(&seal.public_b64u(), "", 64).unwrap(),
        HOST,
        "XAI_API_KEY",
        "xai-abc",
    );
    assert_eq!(seal.open(HOST, &s).unwrap(), "xai-abc");
    let mut ct = webauthn::unb64(s.ct.as_deref().unwrap(), "", 4096).unwrap();
    ct[0] ^= 1;
    s.ct = Some(webauthn::b64(&ct));
    assert!(seal.open(HOST, &s).unwrap_err().contains("does not open"));
    let space = seal::seal(
        &webauthn::unb64(&seal.public_b64u(), "", 64).unwrap(),
        HOST,
        "XAI_API_KEY",
        "two words",
    );
    assert!(seal
        .open(HOST, &space)
        .unwrap_err()
        .contains("holds a space"));
    let both = Sealed {
        remove: true,
        ..s.clone()
    };
    let d = Doc {
        keys: Some(vec![both]),
        ..doc.clone()
    };
    assert!(open_keys(&seal, HOST, &d)
        .unwrap_err()
        .contains("taken out and sealed at once"));
    let x = seal::seal(
        &webauthn::unb64(&seal.public_b64u(), "", 64).unwrap(),
        HOST,
        "XAI_API_KEY",
        "xai-abc",
    );
    let twice = Doc {
        keys: Some(vec![x.clone(), x]),
        ..doc.clone()
    };
    assert!(open_keys(&seal, HOST, &twice)
        .unwrap_err()
        .contains("named twice"));
    let none = Doc {
        keys: Some(Vec::new()),
        ..doc
    };
    assert!(open_keys(&seal, HOST, &none)
        .unwrap_err()
        .contains("sets 0 keys"));

    // agent.env: the owner's lines stay, a key named is replaced in place, a new one goes at
    // the end, one taken out goes.
    let text = "# the owner's note\nexport GITHUB_TOKEN=ghp_old\nOPENAI_API_KEY='sk-old'\nGEMINI_API_KEY=keep\n";
    let merged = merge_agent_env(text, &keys).unwrap();
    assert_eq!(
        merged,
        format!(
            "# the owner's note\nGITHUB_TOKEN={}\nGEMINI_API_KEY=keep\nCLAUDE_CODE_OAUTH_TOKEN={}\n",
            c["keys"]["values"]["GITHUB_TOKEN"].as_str().unwrap(),
            c["keys"]["values"]["CLAUDE_CODE_OAUTH_TOKEN"].as_str().unwrap()
        )
    );
    assert_eq!(
        agent_key_names(&merged),
        ["GITHUB_TOKEN", "GEMINI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
    );
    let fresh = merge_agent_env("", &keys).unwrap();
    assert!(fresh.starts_with("# The agent keys (#328"));
    assert!(merge_agent_env("not a line\n", &keys)
        .unwrap_err()
        .contains("fix it at the host"));
}

#[test]
fn the_seal_key_is_made_once_and_kept_in_the_keychain_on_a_mac() {
    let state = crate::run::state::tempdir().join("state");
    let a = SealKey::load_or_create(&state).unwrap();
    let b = SealKey::load_or_create(&state).unwrap();
    assert_eq!(a.public_b64u(), b.public_b64u());
    assert_eq!(
        seal::read_public(&state).as_deref(),
        Some(a.public_b64u().as_str())
    );
    assert!(a.fingerprint().starts_with("SHA256:"));
    assert_eq!(
        fs::metadata(state.join(seal::KEY_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    fs::set_permissions(
        state.join(seal::KEY_FILE),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(SealKey::load_or_create(&state)
        .unwrap_err()
        .contains("its owner's alone"));

    // A Mac: the private half in the keychain, never in a file.
    let mac = crate::run::state::tempdir().join("state");
    let mut k = keychain::Fake::default();
    let account = seal::keychain_account(&mac);
    let a = SealKey::load_or_create_in(&mac, &mut k, &account).unwrap();
    assert!(!mac.join(seal::KEY_FILE).exists());
    assert_eq!(k.items.len(), 1);
    let b = SealKey::load_or_create_in(&mac, &mut k, &account).unwrap();
    assert_eq!(a.public_b64u(), b.public_b64u());
    k.locked = Some("the keychain is locked".into());
    assert_eq!(
        SealKey::load_or_create_in(&mac, &mut k, &account).unwrap_err(),
        "the keychain is locked"
    );
}

/// A virtual authenticator in the agent's own tests (an Ed25519 passkey, which keeps no
/// counter, as synced passkeys do): what the owner's browser answers, made at the test's
/// own time — the real-engine test (`run::engine_tests`) runs on the wall clock, which the
/// recorded fixtures (made for 2027) are not.
pub(crate) struct Authenticator {
    pair: aws_lc_rs::signature::Ed25519KeyPair,
    pub credential: String,
}

impl Authenticator {
    pub fn new() -> Self {
        use aws_lc_rs::rand::{SecureRandom, SystemRandom};
        let doc =
            aws_lc_rs::signature::Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let mut id = [0u8; 16];
        SystemRandom::new().fill(&mut id).unwrap();
        Self {
            pair: aws_lc_rs::signature::Ed25519KeyPair::from_pkcs8(doc.as_ref()).unwrap(),
            credential: webauthn::b64(&id),
        }
    }

    /// Its COSE public key, base64url, as the pool stored it at registration.
    pub fn cose(&self) -> String {
        use aws_lc_rs::signature::KeyPair;
        let x = self.pair.public_key().as_ref().to_vec();
        webauthn::b64(&webauthn::tests::cose(&[
            (1, Ok(1)),
            (3, Ok(webauthn::EDDSA)),
            (-1, Ok(6)),
            (-2, Err(&x)),
        ]))
    }

    /// Its answer to `doc` on `origin` for `rp_id`, the user present and verified.
    pub fn assert(&self, doc: &str, rp_id: &str, origin: &str) -> Assertion {
        self.assert_at(doc, rp_id, origin, 0)
    }

    /// The same, with its signature counter at `counter` (a synced passkey keeps 0).
    pub fn assert_at(&self, doc: &str, rp_id: &str, origin: &str, counter: u32) -> Assertion {
        use sha2::{Digest, Sha256};
        let cd = serde_json::json!({"type": "webauthn.get", "challenge": webauthn::challenge_of(doc.as_bytes()), "origin": origin, "crossOrigin": false}).to_string();
        let mut auth = Sha256::digest(rp_id.as_bytes()).to_vec();
        auth.push(0x05);
        auth.extend_from_slice(&counter.to_be_bytes());
        let mut signed = auth.clone();
        signed.extend_from_slice(&Sha256::digest(cd.as_bytes()));
        Assertion {
            credential: self.credential.clone(),
            client_data: webauthn::b64(cd.as_bytes()),
            authenticator_data: webauthn::b64(&auth),
            signature: webauthn::b64(self.pair.sign(&signed).as_ref()),
            user_handle: None,
        }
    }

    /// A document as the pool writes one, issued at `now` and holding an hour.
    pub fn doc(act: &str, host: &str, version: Option<u64>, now: i64, rest: &Value) -> String {
        let mut d = serde_json::json!({
            "schema": SCHEMA, "act": act, "host": host,
            "issued_at": crate::capacity::utc(u64::try_from(now - 60).unwrap()),
            "not_after": crate::capacity::utc(u64::try_from(now + 3600).unwrap()),
            "by": "m1",
        });
        if let Some(v) = version {
            d["version"] = v.into();
        }
        for (k, v) in rest.as_object().unwrap() {
            d[k] = v.clone();
        }
        d.to_string()
    }

    /// The pin the site prints for `host`, made at `now`.
    pub fn pin(&self, host: &str, now: i64) -> String {
        let doc = Self::doc(
            "pin-passkey",
            host,
            None,
            now,
            &serde_json::json!({"rp_id": "omarchy-pool.org", "origin": "https://omarchy-pool.org"}),
        );
        let a = self.assert(&doc, "omarchy-pool.org", "https://omarchy-pool.org");
        webauthn::b64(
            serde_json::json!({"doc": doc, "assertion": a, "public_key": self.cose(), "alg": webauthn::EDDSA})
                .to_string()
                .as_bytes(),
        )
    }

    /// Its signed widening or agent keys: (the document, the assertion).
    pub fn sign(
        &self,
        act: &str,
        host: &str,
        version: u64,
        now: i64,
        rest: &Value,
    ) -> (String, Assertion) {
        let doc = Self::doc(act, host, Some(version), now, rest);
        let a = self.assert(&doc, "omarchy-pool.org", "https://omarchy-pool.org");
        (doc, a)
    }
}

#[test]
fn a_virtual_authenticator_pins_and_signs_at_any_time() {
    let now = 1_900_000_000;
    let state = crate::run::state::tempdir().join("state");
    let owner = Authenticator::new();
    assert!(pin(&state, HOST, POOL, &owner.pin(HOST, now), now)
        .unwrap()
        .contains("EdDSA"));
    let rec = Record::load(&state).unwrap();
    let (doc, a) = owner.sign(
        "widen-envelope",
        HOST,
        1,
        now,
        &serde_json::json!({"envelope": {"max_units": 4}}),
    );
    let (d, counter) =
        verify_signed(&rec, doc.as_bytes(), &a, Act::WidenEnvelope, HOST, now).unwrap();
    assert_eq!((d.version, counter), (Some(1), 0));
    // Another of the owner's passkeys, not the one pinned.
    let other = Authenticator::new();
    let (doc, a) = other.sign(
        "widen-envelope",
        HOST,
        1,
        now,
        &serde_json::json!({"envelope": {"max_units": 4}}),
    );
    assert!(
        verify_signed(&rec, doc.as_bytes(), &a, Act::WidenEnvelope, HOST, now)
            .unwrap_err()
            .contains("signed with another passkey")
    );
}

#[test]
fn a_document_living_over_two_hours_or_a_counter_gone_back_is_refused() {
    let now = 1_900_000_000;
    let state = crate::run::state::tempdir().join("state");
    let owner = Authenticator::new();
    pin(&state, HOST, POOL, &owner.pin(HOST, now), now).unwrap();
    let mut rec = Record::load(&state).unwrap();
    let rp = ("omarchy-pool.org", "https://omarchy-pool.org");
    // Three hours to live: a document the pool should never write.
    let mut long: Value = serde_json::from_str(&Authenticator::doc(
        "widen-envelope",
        HOST,
        Some(1),
        now,
        &serde_json::json!({"envelope": {"max_units": 4}}),
    ))
    .unwrap();
    long["not_after"] = crate::capacity::utc(u64::try_from(now + 3 * 3600).unwrap()).into();
    let long = long.to_string();
    let a = owner.assert(&long, rp.0, rp.1);
    assert!(
        verify_signed(&rec, long.as_bytes(), &a, Act::WidenEnvelope, HOST, now)
            .unwrap_err()
            .contains("longer than two hours")
    );
    // A passkey that counts: 5, then 3 — a copy of the key answering.
    let w = |v: u64| {
        Authenticator::doc(
            "widen-envelope",
            HOST,
            Some(v),
            now,
            &serde_json::json!({"envelope": {"max_units": 4}}),
        )
    };
    let d1 = w(1);
    let (_, counter) = verify_signed(
        &rec,
        d1.as_bytes(),
        &owner.assert_at(&d1, rp.0, rp.1, 5),
        Act::WidenEnvelope,
        HOST,
        now,
    )
    .unwrap();
    assert_eq!(counter, 5);
    rec.version = 1;
    rec.passkey.as_mut().unwrap().counter = counter;
    let d2 = w(2);
    let e = verify_signed(
        &rec,
        d2.as_bytes(),
        &owner.assert_at(&d2, rp.0, rp.1, 3),
        Act::WidenEnvelope,
        HOST,
        now,
    )
    .unwrap_err();
    assert!(e.contains("counter went from 5 to 3"), "{e}");
    // Ahead of the host's clock by more than five minutes.
    let ahead = Authenticator::doc(
        "widen-envelope",
        HOST,
        Some(2),
        now + 900,
        &serde_json::json!({"envelope": {"max_units": 4}}),
    );
    let e = verify_signed(
        &rec,
        ahead.as_bytes(),
        &owner.assert_at(&ahead, rp.0, rp.1, 6),
        Act::WidenEnvelope,
        HOST,
        now,
    )
    .unwrap_err();
    assert!(e.contains("ahead of this host's clock"), "{e}");
}
