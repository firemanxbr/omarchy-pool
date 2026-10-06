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

/// The task subnets install writes by default.
fn task() -> Vec<Cidr> {
    crate::install::net::parse_list(crate::install::TASK_SUBNETS).unwrap()
}

fn joined(sources: &Sources, data: &Path) -> String {
    addresses::joined(&addresses::detect(sources, data, &task()))
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
    // An address routed to the host on `lo` (an anycast /128, a service address) is its
    // own like any other, IPv4 or IPv6; loopback's alone is not.
    let fib = "Local:\n  +-- 0.0.0.0/0 1 0 0\n     |-- 127.0.0.1\n        /32 host LOCAL\n     |-- 198.51.100.53\n        /32 host LOCAL\n";
    let lo = "00000000000000000000000000000001 01 80 10 80       lo\n20010db8abcdffff0000000000000053 01 80 00 80       lo\n";
    assert_eq!(
        addresses::joined(&addresses::of_interfaces(fib, "", lo, &task())),
        "198.51.100.53,2001:db8:abcd:ffff::53"
    );
    // No lists at all (macOS, or a kernel without IPv6): nothing, and no key.
    let empty = Sources {
        proc_net: none.join("absent"),
    };
    assert_eq!(joined(&empty, &none), "");
    let r = Rendered {
        addresses: Vec::new(),
        envelope: None,
        plain: false,
    };
    assert!(r.lines().unwrap().is_empty());

    // A bridge's address is left out only where the egress refuses it anyway (a private,
    // CGNAT, link-local or unique local one, or one in the task subnets): a bridge on a
    // routed public range, or docker's `fixed-cidr-v6` from the host's delegated prefix,
    // is the host's own.
    let routes = format!(
        "{}br-0a0b0c0d0e0f\t006433C6\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n",
        fs::read_to_string(fixture("home").proc_net.join("route")).unwrap()
    );
    let fib = "Local:\n  +-- 0.0.0.0/0 1 0 0\n     |-- 10.231.0.1\n        /32 host LOCAL\n     |-- 172.17.0.1\n        /32 host LOCAL\n     |-- 192.168.1.20\n        /32 host LOCAL\n     |-- 198.51.100.1\n        /32 host LOCAL\n";
    let v6 = "fe800000000000000042acfffe110001 03 40 20 80  docker0\nfd000000000000000000000000000001 03 40 00 80  docker0\n20010db8000100050000000000000001 03 40 00 80  docker0\nfe80000000000000a8bbccfffedd0001 07 40 20 80 vethab12cd3\n";
    assert_eq!(
        addresses::joined(&addresses::of_interfaces(fib, &routes, v6, &task())),
        "192.168.1.20,198.51.100.1,2001:db8:1:5::/64"
    );
    // The same public range taken for the task subnets: its bridges come and go with tasks.
    let public_tasks = crate::install::net::parse_list("198.51.100.0/24").unwrap();
    assert_eq!(
        addresses::joined(&addresses::of_interfaces(fib, &routes, v6, &public_tasks)),
        "192.168.1.20,2001:db8:1:5::/64"
    );
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
        &task(),
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
    // What the run loop keeps when the pool's edge says the host comes from elsewhere now.
    addresses::keep_seen(
        &data,
        "198.51.100.21".parse().unwrap(),
        "2026-10-03T01:00:00Z",
    )
    .unwrap();
    assert_eq!(
        addresses::seen(&data),
        Some("198.51.100.21".parse().unwrap())
    );
    assert_eq!(mode(&data.join(addresses::SEEN_FILE)), 0o600);
}

#[test]
fn the_address_the_pool_s_edge_saw_is_the_trace_s_ip_line_alone() {
    let trace = "fl=465f1\nh=pkgs.omarchy-pool.org\nip=198.51.100.20\nts=1790000000.1\nvisit_scheme=https\nuag=omarchy-agent/0.3.1\ncolo=LIS\nhttp=http/1.1\nloc=PT\ntls=TLSv1.3\nsni=plaintext\nwarp=off\n";
    assert_eq!(
        addresses::from_trace(trace),
        Some("198.51.100.20".parse().unwrap())
    );
    assert_eq!(
        addresses::from_trace("ip=2001:db8::7\n"),
        Some("2001:db8::7".parse().unwrap())
    );
    for bad in [
        "",
        "<html>not a trace</html>",
        "ip=198.51.100.20,10.0.0.1\n",
        "ip=127.0.0.1\n",
        "ip=0.0.0.0\n",
        "ip=198.51.100.20 OMARCHY_X=1\n",
    ] {
        assert_eq!(addresses::from_trace(bad), None, "{bad:?}");
    }
    // An IPv4 address in its IPv6 form is kept as IPv4, as the egress reads its deny list:
    // the edge's line, the probe's and egress.json alike.
    let v4: std::net::IpAddr = "198.51.100.20".parse().unwrap();
    assert_eq!(addresses::from_trace("ip=::ffff:198.51.100.20\n"), Some(v4));
    assert_eq!(addresses::from_trace("ip=::ffff:127.0.0.1\n"), None);
    assert_eq!(
        crate::install::egress::seen("egress seen ::ffff:198.51.100.20\n"),
        Some(v4)
    );
    let data = tempdir();
    fs::write(
        data.join(addresses::SEEN_FILE),
        "{\"public\":\"::ffff:198.51.100.20\",\"at\":\"2026-10-03T00:00:00Z\"}",
    )
    .unwrap();
    assert_eq!(addresses::seen(&data), Some(v4));
    assert!(joined(&fixture("vps"), &data).starts_with("198.51.100.20,203.0.113.10,"));
    addresses::keep_seen(
        &data,
        "::ffff:198.51.100.21".parse().unwrap(),
        "2026-10-03T01:00:00Z",
    )
    .unwrap();
    assert!(fs::read_to_string(data.join(addresses::SEEN_FILE))
        .unwrap()
        .contains("\"198.51.100.21\""));
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
        task_subnets: task(),
    }
}

#[test]
fn rendering_keeps_the_registration_and_every_line_the_agent_does_not_own() {
    let home = addresses::detect(&fixture("home"), &tempdir(), &task());
    let r = Rendered {
        addresses: home.clone(),
        envelope: Some(envelope(
            "/srv/omarchy-pool/host-secrets",
            Budget {
                calls_per_day: Some(900),
                ..Budget::default()
            },
        )),
        plain: false,
    };
    // What the agent of #321 wrote, and an owner's line and comment after it.
    let old = format!(
        "# The host worker token (omarchy-agent, #321): the dispatcher's only, rotated every 30 days.\n# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={OMW}\n# mine\nTZ=Europe/Lisbon\nOMARCHY_HOST_ADDRESSES=10.0.0.1\nOMARCHY_AGENT_CALLS_PER_TASK=7\n"
    );
    // The token's line is written from `plain` alone (#327): none, none here.
    let text = render(&old, None, None, Some(&r)).unwrap();
    assert_eq!(
        text,
        format!(
            "{HEADER}\n# worker: m1-rack-0a9z\nOMARCHY_HOST_ADDRESSES=10.8.0.2,192.168.1.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64\nOMARCHY_SECRETS_DIR=/srv/omarchy-pool/host-secrets\nOMARCHY_AGENT_CALLS_PER_DAY=900\n# mine\nTZ=Europe/Lisbon\n"
        )
    );
    // Rendered again with the same: the same bytes.
    assert_eq!(render(&text, None, None, Some(&r)).unwrap(), text);
    // For a release from before the token file: the token after its registration.
    let plain = render(&text, None, Some(OMW), Some(&r)).unwrap();
    assert_eq!(
        plain,
        text.replace(
            "# worker: m1-rack-0a9z\n",
            &format!("# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={OMW}\n")
        )
    );
    // Only the token put in or taken out (a round's refresh_token): every other line as the
    // file has it, in the same places.
    assert_eq!(render(&plain, None, None, None).unwrap(), text);
    assert_eq!(render(&text, None, Some(OMW), None).unwrap(), plain);
    // A rotation: a new registration line, the token as `plain` says, everything else kept.
    let new = format!("omw_{}", "a1".repeat(24));
    let rotated = render(&plain, Some("m1-rack-0a9z"), Some(&new), Some(&r)).unwrap();
    assert_eq!(rotated, plain.replace(OMW, &new));
    let moved_worker = render(&text, Some("m1-rack-1b2c"), None, Some(&r)).unwrap();
    assert_eq!(moved_worker, text.replace("m1-rack-0a9z", "m1-rack-1b2c"));
    // An address change: the addresses only.
    let moved = Rendered {
        addresses: addresses::detect(&fixture("vps"), &tempdir(), &task()),
        ..r.clone()
    };
    let after = render(&plain, None, Some(OMW), Some(&moved)).unwrap();
    assert!(after.contains(&format!("OMARCHY_WORKER_TOKEN={OMW}\n")));
    assert!(after.contains("OMARCHY_HOST_ADDRESSES=203.0.113.10,2001:db8:abcd::/64,fe80::/64\n"));
    assert_eq!(after.lines().count(), plain.lines().count());
    // An envelope without a budget leaves the dispatcher's defaults: no budget line.
    let unbudgeted = Rendered {
        envelope: Some(envelope(
            "/srv/omarchy-pool/host-secrets",
            Budget::default(),
        )),
        ..r.clone()
    };
    assert!(!render(&text, None, None, Some(&unbudgeted))
        .unwrap()
        .contains("OMARCHY_AGENT_"));
    // Before agent.toml (a first enrollment): the file's own secrets and budget lines stay.
    let early = Rendered {
        addresses: home,
        envelope: None,
        plain: false,
    };
    let kept = render(&text, Some("m1-rack-0a9z"), None, Some(&early)).unwrap();
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
        assert!(render(&text, None, None, Some(&r)).is_err(), "{bad:?}");
    }
}

/// A set directory of the agent's own (0700), with its `etc/`.
fn set_dir() -> (PathBuf, PathBuf) {
    let d = tempdir();
    fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
    let env = path_in(&d);
    // 0700 whatever the umask, as the agent's own etc/ is.
    fs::create_dir(env.parent().unwrap()).unwrap();
    fs::set_permissions(env.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    crate::host::private_dir(env.parent().unwrap()).unwrap();
    (d, env)
}

#[test]
fn refresh_never_makes_the_files_and_writes_them_only_when_they_change() {
    let (d, env) = set_dir();
    let file = token_path_in(&d);
    assert_eq!(token_path(&env).unwrap(), file);
    assert!(token_path(&d.join("dispatcher.env")).is_err());
    let r = Rendered {
        addresses: addresses::detect(&fixture("home"), &d, &task()),
        envelope: Some(envelope("/srv/s", Budget::default())),
        plain: false,
    };
    // No file: no token yet (the owner has not confirmed), and none is made.
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::NoFile);
    assert!(!env.exists() && !file.exists());
    write_token(&env, "m1-rack-0a9z", OMW, &r).unwrap();
    assert_eq!(read_token(&file).unwrap(), Some((OMW.to_owned(), 0o400)));
    assert_eq!(mode(&env), 0o600);
    assert_eq!(mode(file.parent().unwrap()), 0o700);
    assert_eq!(mode(file.parent().unwrap().parent().unwrap()), 0o700);
    let text = fs::read_to_string(&env).unwrap();
    assert!(!text.contains(OMW), "{text}");
    assert!(text.contains("# worker: m1-rack-0a9z\n"), "{text}");
    assert!(text.contains("OMARCHY_SECRETS_DIR=/srv/s\n"), "{text}");
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::Unchanged);
    // The same text with a mode others may read: written again, 0600; the token file's
    // mode too.
    fs::set_permissions(&env, fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::Written);
    assert_eq!(mode(&env), 0o600);
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::Written);
    assert_eq!(read_token(&file).unwrap(), Some((OMW.to_owned(), 0o400)));
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
    // A token file that is a link, or another's to write, is refused and never written
    // through.
    fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &file).unwrap();
    assert!(refresh(&env, &r).unwrap_err().contains("symbolic link"));
    assert!(write_token(&env, "m1-rack-0a9z", OMW, &r).is_err());
    assert_eq!(
        fs::read_to_string(&elsewhere).unwrap(),
        "OMARCHY_WORKER_TOKEN=theirs\n"
    );
}

#[test]
fn an_upgrade_moves_the_token_to_its_file_and_keeps_it_in_the_env_file_only_for_an_older_release() {
    let (d, env) = set_dir();
    let file = token_path_in(&d);
    let data = d.join("data");
    // What #371's agent left: the token in the env file, and the owner's line.
    let old = format!(
        "# The dispatcher's environment (omarchy-agent, #321, #371): the host worker token (rotated every 30 days), the host's own addresses, the secrets directory and the agent budget; the agent renders its own lines and keeps every other one.\n# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={OMW}\nOMARCHY_HOST_ADDRESSES=192.168.1.20\nTZ=UTC\n"
    );
    fs::write(&env, &old).unwrap();
    fs::set_permissions(&env, fs::Permissions::from_mode(0o600)).unwrap();
    // The release in place is from before #327: its template reads the token from the env
    // file, so it stays there too, and the file gets it.
    let good = crate::run::config::Paths { data: data.clone() }.last_good("host");
    fs::create_dir_all(&good).unwrap();
    let legacy = crate::run::fake::before_token_file(crate::run::fake::HOST_COMPOSE);
    fs::write(good.join("compose.yml"), &legacy).unwrap();
    assert!(older_release_here(&data));
    let r = Rendered::now(&fixture("home"), &data, None);
    assert!(r.plain);
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::TokenMoved);
    assert_eq!(read_token(&file).unwrap(), Some((OMW.to_owned(), 0o400)));
    let text = fs::read_to_string(&env).unwrap();
    assert!(
        text.starts_with(&format!(
            "{HEADER}\n# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={OMW}\n"
        )),
        "{text}"
    );
    assert!(text.ends_with("\nTZ=UTC\n"), "{text}");
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::Unchanged);
    // A round stages the release that reads the file: the token stays while the older one
    // is still the applied one (a revert starts it again).
    let staging = crate::run::config::Paths { data: data.clone() }.staging("host");
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("compose.yml"), crate::run::fake::HOST_COMPOSE).unwrap();
    assert!(older_release_here(&data));
    assert_eq!(refresh_token(&env, true).unwrap(), Refresh::Unchanged);
    // It committed (staging became last-good): no release here reads the env file's token
    // any more, so the next refresh takes it out, and the file keeps it.
    fs::remove_dir_all(&good).unwrap();
    fs::rename(&staging, &good).unwrap();
    assert!(!older_release_here(&data));
    let r = Rendered::now(&fixture("home"), &data, None);
    assert!(!r.plain);
    assert_eq!(refresh(&env, &r).unwrap(), Refresh::Written);
    let text = fs::read_to_string(&env).unwrap();
    assert!(!text.contains(OMW) && !text.contains(TOKEN), "{text}");
    assert!(text.contains("# worker: m1-rack-0a9z\n"), "{text}");
    assert_eq!(read_token(&file).unwrap(), Some((OMW.to_owned(), 0o400)));
    // A rollback stages an older release again: its round puts the token back, from the file.
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("compose.yml"), &legacy).unwrap();
    assert_eq!(
        refresh_token(&env, older_release_here(&data)).unwrap(),
        Refresh::Written
    );
    assert!(fs::read_to_string(&env)
        .unwrap()
        .contains(&format!("\nOMARCHY_WORKER_TOKEN={OMW}\n")));
    // An older agent (a self-update it rolled back) rotated the token into the env file: the
    // env file's is the newest, and the file takes it.
    let newer = format!("omw_{}", "b2".repeat(24));
    let rotated = fs::read_to_string(&env).unwrap().replace(OMW, &newer);
    crate::host::replace(&env, rotated.as_bytes()).unwrap();
    assert_eq!(refresh_token(&env, true).unwrap(), Refresh::TokenMoved);
    assert_eq!(read_token(&file).unwrap(), Some((newer.clone(), 0o400)));
    // A token line the agent cannot move stops the writer, and nothing is lost.
    let odd = fs::read_to_string(&env)
        .unwrap()
        .replace(&newer, "\"two words\"");
    crate::host::replace(&env, odd.as_bytes()).unwrap();
    let e = refresh_token(&env, false).unwrap_err();
    assert!(e.contains("not a token the agent can move"), "{e}");
    assert_eq!(fs::read_to_string(&env).unwrap(), odd);
    assert_eq!(read_token(&file).unwrap(), Some((newer, 0o400)));
}

#[test]
fn a_rotation_writes_the_token_where_every_release_here_reads_it() {
    let (d, env) = set_dir();
    let file = token_path_in(&d);
    let home = addresses::detect(&fixture("home"), &d, &task());
    let r = Rendered {
        addresses: home.clone(),
        envelope: None,
        plain: false,
    };
    write_token(&env, "m1-rack-0a9z", OMW, &r).unwrap();
    let new = format!("omw_{}", "a1".repeat(24));
    // With an older release here, in both; then without, in its file alone, the env file
    // otherwise the same.
    let older = Rendered {
        plain: true,
        ..r.clone()
    };
    write_token(&env, "m1-rack-0a9z", &new, &older).unwrap();
    assert_eq!(read_token(&file).unwrap(), Some((new.clone(), 0o400)));
    let both = fs::read_to_string(&env).unwrap();
    assert!(
        both.contains(&format!("\nOMARCHY_WORKER_TOKEN={new}\n")),
        "{both}"
    );
    write_token(&env, "m1-rack-0a9z", OMW, &r).unwrap();
    assert_eq!(read_token(&file).unwrap(), Some((OMW.to_owned(), 0o400)));
    assert_eq!(
        fs::read_to_string(&env).unwrap(),
        both.replace(&format!("OMARCHY_WORKER_TOKEN={new}\n"), "")
    );
    // Never anything but one token on one line.
    assert!(write_token(&env, "m1-rack-0a9z", "omw_a\nBASH_ENV=/tmp/x", &r).is_err());
    assert_eq!(read_token(&file).unwrap(), Some((OMW.to_owned(), 0o400)));
}

#[test]
fn a_token_write_stopped_between_any_two_of_its_writes_leaves_the_new_token_with_its_registration()
{
    // A crash, a kill or a full disk between the env file and the token file: whatever the
    // host held, the next refresh finds the new token in its file beside its own
    // registration, and no older token anywhere (an env line is taken for the newest).
    let old = format!("omw_{}", "a1".repeat(24));
    let new = format!("omw_{}", "b2".repeat(24));
    let with_old_line = format!("# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={old}\nTZ=UTC\n");
    // What the env file held, whether the token file held the older token, and whether an
    // older release is here.
    let hosts = [
        // A first enrollment: nothing yet.
        (None, false, false),
        // The env file lost, the token file kept.
        (None, true, false),
        // A rotation on a host past its move.
        (
            Some("# worker: m1-rack-0a9z\nTZ=UTC\n".to_owned()),
            true,
            false,
        ),
        // The older token's line not taken out yet: a suspended host, or the minute after
        // the last older release left.
        (Some(with_old_line.clone()), true, false),
        // Another registration's: a retired host's machine enrolled again.
        (
            Some("# worker: m1-old-0000\nTZ=UTC\n".to_owned()),
            true,
            false,
        ),
        // An older release here: the token in both.
        (Some(with_old_line), true, true),
    ];
    for (held, file_held, plain) in hosts {
        let r = Rendered {
            addresses: Vec::new(),
            envelope: None,
            plain,
        };
        let steps = token_steps(
            held.as_deref(),
            Path::new("etc/dispatcher.env"),
            "m1-rack-0a9z",
            &new,
            &r,
        )
        .unwrap();
        for stop in 1..=steps.len() {
            let (d, env) = set_dir();
            let file = token_path_in(&d);
            if let Some(t) = &held {
                fs::write(&env, t).unwrap();
                fs::set_permissions(&env, fs::Permissions::from_mode(0o600)).unwrap();
            }
            if file_held {
                write_token_file(&file, &old).unwrap();
            }
            for step in &steps[..stop] {
                apply(&env, &file, &new, step).unwrap();
            }
            let what = format!("{held:?}, stopped after {stop} of {steps:?}");
            assert_ne!(refresh(&env, &r).unwrap(), Refresh::NoFile, "{what}");
            assert_eq!(
                read_token(&file).unwrap(),
                Some((new.clone(), 0o400)),
                "{what}"
            );
            let text = fs::read_to_string(&env).unwrap();
            assert_eq!(worker_line(&text), Some("m1-rack-0a9z"), "{what}: {text}");
            assert_eq!(
                token_line(&text, &env).unwrap(),
                plain.then(|| new.clone()),
                "{what}: {text}"
            );
            assert!(!text.contains(&old), "{what}: {text}");
            assert!(holds_token(&env), "{what}");
        }
    }
    // A rotation on a settled host writes no token into the env file, even for a moment.
    let r = Rendered {
        addresses: Vec::new(),
        envelope: None,
        plain: false,
    };
    let settled = "# worker: m1-rack-0a9z\nTZ=UTC\n";
    let steps = token_steps(
        Some(settled),
        Path::new("etc/dispatcher.env"),
        "m1-rack-0a9z",
        &new,
        &r,
    )
    .unwrap();
    assert!(
        matches!(steps.as_slice(), [Step::File, Step::Env(t)] if !t.contains(&new)),
        "{steps:?}"
    );
}

#[test]
fn a_refresh_waits_for_another_writer_and_never_puts_back_the_token_it_replaced() {
    let (d, env) = set_dir();
    let r = Rendered {
        addresses: addresses::detect(&fixture("home"), &d, &task()),
        envelope: None,
        plain: true,
    };
    write_token(&env, "m1-rack-0a9z", OMW, &r).unwrap();
    // `omarchy-agent token` in another process holds etc/ from its read to its renames; the
    // run loop's refresh, with an address change, waits for it.
    let rotation = lock(&env).unwrap().expect("etc/ is there");
    let moved = Rendered {
        addresses: addresses::detect(&fixture("vps"), &d, &task()),
        envelope: None,
        plain: true,
    };
    let refresh_in_loop = {
        let (env, moved) = (env.clone(), moved.clone());
        std::thread::spawn(move || refresh(&env, &moved))
    };
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        !refresh_in_loop.is_finished(),
        "a refresh waits while etc/ is held"
    );
    let new = format!("omw_{}", "a1".repeat(24));
    let rotated = render(
        &fs::read_to_string(&env).unwrap(),
        Some("m1-rack-0a9z"),
        Some(&new),
        Some(&r),
    )
    .unwrap();
    crate::host::replace(&env, rotated.as_bytes()).unwrap();
    write_token_file(&token_path_in(&d), &new).unwrap();
    drop(rotation);
    assert_eq!(refresh_in_loop.join().unwrap().unwrap(), Refresh::Written);
    let text = fs::read_to_string(&env).unwrap();
    assert!(
        text.contains(&format!("OMARCHY_WORKER_TOKEN={new}\n")),
        "{text}"
    );
    assert!(!text.contains(OMW), "{text}");
    assert!(
        text.contains("OMARCHY_HOST_ADDRESSES=203.0.113.10,"),
        "{text}"
    );
    assert_eq!(read_token(&token_path_in(&d)).unwrap(), Some((new, 0o400)));
    // No etc/ at all: nothing to lock, no file, none made.
    let none = path_in(&d.join("elsewhere"));
    assert_eq!(refresh(&none, &r).unwrap(), Refresh::NoFile);
    assert!(!none.exists());
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
    // The token in its own file (#327) is scrubbed too, once.
    let other = format!("omw_{}", "c3".repeat(24));
    fs::create_dir_all(token_path_in(&d).parent().unwrap()).unwrap();
    fs::write(token_path_in(&d), format!("{other}\n")).unwrap();
    assert_eq!(
        crate::run::journal::env_secrets(&d),
        [other.as_str(), OMW, "hunter2hunter2"]
    );
    fs::write(token_path_in(&d), format!("{OMW}\n")).unwrap();
    assert_eq!(
        crate::run::journal::env_secrets(&d),
        [OMW, "hunter2hunter2"]
    );
}
