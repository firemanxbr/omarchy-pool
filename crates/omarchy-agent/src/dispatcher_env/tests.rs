//! `etc/dispatcher.env` (#371): the host's addresses from interface lists (fixtures under
//! `tests/fixtures/addresses/`: a home LAN host with docker's bridges and IPv6, a VPS with
//! a public /32), the budget from the envelope, and the file rendered with its token and
//! the owner's lines kept.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::addresses::{self, Seen};
use super::*;
use crate::run::state::tempdir;

fn fixture(name: &str) -> Sources {
    Sources {
        proc_net: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/addresses")
            .join(name),
    }
}

fn joined(sources: &Sources, data: &Path) -> String {
    addresses::joined(&addresses::detect(sources, data))
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

const OMW: &str = "omw_0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

#[test]
fn every_address_of_the_host_s_interfaces_but_loopback_and_container_bridges() {
    let none = tempdir();
    // Home: the LAN and a WireGuard address; docker0's and a task network's (br-…) are
    // the engine's and come and go; IPv6 as its /64 (the stable and the temporary
    // address are one), a DHCPv6 /128 as itself, link-local once; docker0's ULA and a
    // veth's link-local are not the host's own interfaces.
    assert_eq!(
        joined(&fixture("home"), &none),
        "10.8.0.2,192.168.1.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64"
    );
    // A VPS: a public /32 with an on-link gateway (no route holds it), a /48 narrowed to
    // the address's /64.
    assert_eq!(
        joined(&fixture("vps"), &none),
        "203.0.113.10,2001:db8:abcd::/64,fe80::/64"
    );
    // No lists at all (macOS, or a kernel without IPv6): nothing, and no key.
    let empty = Sources {
        proc_net: none.join("absent"),
    };
    assert_eq!(joined(&empty, &none), "");
    let r = Rendered {
        addresses: Vec::new(),
        envelope: None,
    };
    assert!(r.lines().unwrap().is_empty());
}

#[test]
fn the_kernel_s_lists_parse_as_the_kernel_writes_them() {
    let fib = fs::read_to_string(fixture("home").proc_net.join("fib_trie")).unwrap();
    // Each local address once although both tables list it; 127.0.0.0's `/8 host LOCAL`
    // is the loopback range, no address of an interface.
    assert_eq!(
        addresses::parse_fib_trie(&fib)
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        [
            "10.8.0.2",
            "10.231.0.1",
            "127.0.0.1",
            "172.17.0.1",
            "192.168.1.20"
        ]
    );
    let v6 = addresses::parse_if_inet6(
        "20010db800010002505400fffe12abcd 02 40 00 00     eth0\nnot a line\nzz 02 40 00 00 eth0\n",
    );
    assert_eq!(v6.len(), 1);
    assert_eq!(
        (v6[0].addr.to_string(), v6[0].prefix, v6[0].iface.as_str()),
        ("2001:db8:1:2:5054:ff:fe12:abcd".into(), 64, "eth0")
    );
    // An address on a bridge's network is the bridge's; one no route holds is the host's.
    let routes = fs::read_to_string(fixture("home").proc_net.join("route")).unwrap();
    let got = addresses::of_interfaces(
        "Local:\n  +-- 0.0.0.0/0 1 0 0\n     |-- 10.231.0.1\n        /32 host LOCAL\n     |-- 100.64.7.7\n        /32 host LOCAL\n",
        &routes,
        "",
    );
    assert_eq!(addresses::joined(&got), "100.64.7.7");
}

#[test]
fn the_public_address_the_egress_probe_saw_joins_them_once() {
    let data = tempdir();
    let write = |ip: &str| {
        let s = Seen {
            public: ip.parse().unwrap(),
            at: "2026-10-03T00:00:00Z".into(),
        };
        fs::write(
            data.join(addresses::SEEN_FILE),
            serde_json::to_vec(&s).unwrap(),
        )
        .unwrap();
    };
    write("198.51.100.20");
    assert_eq!(
        joined(&fixture("home"), &data),
        "10.8.0.2,192.168.1.20,198.51.100.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64"
    );
    // Inside a /64 already refused, or the LAN address itself: nothing added.
    write("2001:db8:1:2::77");
    assert_eq!(
        joined(&fixture("home"), &data),
        "10.8.0.2,192.168.1.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64"
    );
    write("192.168.1.20");
    assert!(!joined(&fixture("home"), &data).contains("192.168.1.20,192.168.1.20"));
    // A file that does not read, or a loopback address, adds nothing.
    fs::write(data.join(addresses::SEEN_FILE), "{\"public\":\"no\"}").unwrap();
    assert_eq!(addresses::seen(&data), None);
    write("127.0.0.1");
    assert_eq!(addresses::seen(&data), None);
}

#[test]
fn the_budget_comes_from_the_envelope_and_none_leaves_the_dispatcher_s_defaults() {
    let budget = |toml_text: &str| {
        let t: toml::Table = toml::from_str(toml_text).unwrap();
        Budget::from_envelope(t.get("envelope").and_then(|e| e.get("agent_budget")))
    };
    assert_eq!(budget("[envelope]\n").unwrap(), Budget::default());
    assert_eq!(
        budget("[envelope]\nagent_budget = { calls_per_task = 200, calls_per_day = 5000 }\n")
            .unwrap(),
        Budget {
            calls_per_task: Some(200),
            calls_per_day: Some(5000),
            ..Budget::default()
        }
    );
    let all = budget(
        "[envelope.agent_budget]\ncalls_per_task = 50\ntokens_per_task = 400000\nminutes_per_task = 30\ncalls_per_day = 900\n",
    )
    .unwrap();
    assert_eq!(
        all.lines(),
        [
            "OMARCHY_AGENT_CALLS_PER_TASK=50",
            "OMARCHY_AGENT_TOKENS_PER_TASK=400000",
            "OMARCHY_AGENT_MINUTES_PER_TASK=30",
            "OMARCHY_AGENT_CALLS_PER_DAY=900",
        ]
    );
    for (bad, why) in [
        ("agent_budget = { calls_per_task = 0 }", "from 1"),
        ("agent_budget = { calls_per_day = -5 }", "from 1"),
        (
            "agent_budget = { calls_per_day = 4294967296 }",
            "from 1 to 4294967295",
        ),
        (
            "agent_budget = { minutes_per_task = 9223372036854775807 }",
            "minutes_per_task",
        ),
        (
            "agent_budget = { tokens_per_task = \"many\" }",
            "tokens_per_task",
        ),
        (
            "agent_budget = { call_per_day = 10 }",
            "call_per_day is none of",
        ),
        ("agent_budget = 200", "not a table"),
    ] {
        let e = budget(&format!("[envelope]\n{bad}\n")).unwrap_err();
        assert!(e.contains(why), "{bad}: {e}");
    }
}

fn envelope(secrets: &str, budget: Budget) -> Envelope {
    Envelope {
        secrets_dir: PathBuf::from(secrets),
        budget,
    }
}

#[test]
fn rendering_keeps_the_token_and_every_line_the_agent_does_not_own() {
    let home = addresses::detect(&fixture("home"), &tempdir());
    let r = Rendered {
        addresses: home.clone(),
        envelope: Some(envelope(
            "/srv/omarchy-pool/host-secrets",
            Budget {
                calls_per_day: Some(900),
                ..Budget::default()
            },
        )),
    };
    // What the agent of #321 wrote, and an owner's line and comment after it.
    let old = format!(
        "# The host worker token (omarchy-agent, #321): the dispatcher's only, rotated every 30 days.\n# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={OMW}\n# mine\nTZ=Europe/Lisbon\nOMARCHY_HOST_ADDRESSES=10.0.0.1\nOMARCHY_AGENT_CALLS_PER_TASK=7\n"
    );
    let text = render(&old, None, &r).unwrap();
    assert_eq!(
        text,
        format!(
            "{HEADER}\n# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={OMW}\nOMARCHY_HOST_ADDRESSES=10.8.0.2,192.168.1.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64\nOMARCHY_SECRETS_DIR=/srv/omarchy-pool/host-secrets\nOMARCHY_AGENT_CALLS_PER_DAY=900\n# mine\nTZ=Europe/Lisbon\n"
        )
    );
    // Rendered again with the same: the same bytes.
    assert_eq!(render(&text, None, &r).unwrap(), text);
    // A rotation: a new token and registration, everything else kept.
    let new = format!("omw_{}", "a1".repeat(24));
    let rotated = render(&text, Some(("m1-rack-0a9z", &new)), &r).unwrap();
    assert_eq!(rotated, text.replace(OMW, &new));
    // An address change: the addresses only, the token as it was.
    let moved = Rendered {
        addresses: addresses::detect(&fixture("vps"), &tempdir()),
        ..r.clone()
    };
    let after = render(&text, None, &moved).unwrap();
    assert!(after.contains(&format!("OMARCHY_WORKER_TOKEN={OMW}\n")));
    assert!(after.contains("OMARCHY_HOST_ADDRESSES=203.0.113.10,2001:db8:abcd::/64,fe80::/64\n"));
    assert_eq!(after.lines().count(), text.lines().count());
    // An envelope without a budget leaves the dispatcher's defaults: no budget line.
    let plain = Rendered {
        envelope: Some(envelope(
            "/srv/omarchy-pool/host-secrets",
            Budget::default(),
        )),
        ..r.clone()
    };
    assert!(!render(&text, None, &plain)
        .unwrap()
        .contains("OMARCHY_AGENT_"));
    // Before agent.toml (a first enrollment): the file's own secrets and budget lines stay.
    let early = Rendered {
        addresses: home,
        envelope: None,
    };
    let kept = render(&text, Some(("m1-rack-0a9z", OMW)), &early).unwrap();
    assert!(kept.contains(
        "OMARCHY_SECRETS_DIR=/srv/omarchy-pool/host-secrets\nOMARCHY_AGENT_CALLS_PER_DAY=900\n"
    ));
    // A secrets directory the dispatcher would refuse is never written.
    for bad in [
        "/srv/my secrets",
        "/srv/x\nBASH_ENV=/tmp/x",
        "relative/dir",
        "/srv/../etc",
    ] {
        let r = Rendered {
            envelope: Some(envelope(bad, Budget::default())),
            ..r.clone()
        };
        assert!(render(&text, None, &r).is_err(), "{bad:?}");
    }
}

#[test]
fn refresh_never_makes_the_file_and_writes_it_only_when_it_changes() {
    let d = tempdir();
    fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
    let env = d.join("dispatcher.env");
    let r = Rendered {
        addresses: addresses::detect(&fixture("home"), &d),
        envelope: Some(envelope("/srv/s", Budget::default())),
    };
    // No file: no token yet (the owner has not confirmed), and none is made.
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::NoFile);
    assert!(!env.exists());
    fs::write(
        &env,
        format!("# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={OMW}\n"),
    )
    .unwrap();
    fs::set_permissions(&env, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::Written);
    assert_eq!(mode(&env), 0o600);
    let text = fs::read_to_string(&env).unwrap();
    assert!(
        text.contains(&format!("OMARCHY_WORKER_TOKEN={OMW}\n")),
        "{text}"
    );
    assert!(text.contains("OMARCHY_SECRETS_DIR=/srv/s\n"), "{text}");
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::Unchanged);
    // The same text with a mode others may read: written again, 0600.
    fs::set_permissions(&env, fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::Written);
    assert_eq!(mode(&env), 0o600);
    // A symbolic link is neither followed nor replaced by a refresh.
    let elsewhere = d.join("elsewhere");
    fs::write(&elsewhere, "OMARCHY_WORKER_TOKEN=theirs\n").unwrap();
    fs::remove_file(&env).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &env).unwrap();
    let e = refresh(&env, &r).unwrap_err();
    assert!(e.contains("symbolic link"), "{e}");
    assert_eq!(
        fs::read_to_string(&elsewhere).unwrap(),
        "OMARCHY_WORKER_TOKEN=theirs\n"
    );
    // A token write replaces it with a file of its own, reading nothing through it.
    write_token(&env, "m1-rack-0a9z", OMW, &r).unwrap();
    assert!(fs::symlink_metadata(&env).unwrap().file_type().is_file());
    assert!(!fs::read_to_string(&env).unwrap().contains("theirs"));
    assert_eq!(
        fs::read_to_string(&elsewhere).unwrap(),
        "OMARCHY_WORKER_TOKEN=theirs\n"
    );
}

#[test]
fn only_the_agent_s_keys_without_a_secret_are_left_unscrubbed() {
    for k in [ADDRESSES, SECRETS_DIR, "OMARCHY_AGENT_CALLS_PER_DAY"] {
        assert!(not_secret(k), "{k}");
    }
    for k in [TOKEN, "ANTHROPIC_API_KEY", "TZ", "OMARCHY_AGENT_ENV"] {
        assert!(!not_secret(k), "{k}");
    }
    let d = tempdir();
    fs::create_dir_all(d.join("etc")).unwrap();
    fs::write(
        d.join("etc/dispatcher.env"),
        format!("OMARCHY_WORKER_TOKEN={OMW}\nOMARCHY_HOST_ADDRESSES=192.168.1.20\nOMARCHY_SECRETS_DIR=/srv/omarchy-pool/host-secrets\nMY_SECRET=hunter2hunter2\n"),
    )
    .unwrap();
    let s = crate::run::journal::env_secrets(&d);
    assert_eq!(s, [OMW, "hunter2hunter2"]);
}
