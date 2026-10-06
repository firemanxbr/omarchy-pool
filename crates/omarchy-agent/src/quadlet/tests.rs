//! The Quadlet rendering of the host set (#330): the template as release.yml renders it,
//! the agent's overlay and an owner's override, field by field; compose's merge and
//! interpolation; the escapes a unit needs; and what is refused by name. That podman's
//! own generator reads what this writes, and runs the same argv compose would, is
//! [`the_generator_reads_the_rendered_host_set`]'s (`tests/agent-quadlet.sh`).

use super::*;

const DIR: &str = "/srv/set";

fn env() -> Vec<(String, String)> {
    [
        ("OMARCHY_WORK_ROOT", "/srv/work"),
        ("OMARCHY_SECRETS_DIR", "/srv/secrets"),
        ("OMARCHY_SOCKET", "/run/user/1000/podman/podman.sock"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect()
}

/// The overlay the run loop writes (`run::rollout`'s `agent.yml`).
const OVERLAY: &str = "# Written by omarchy-agent: its labels on every service of the set.
services:
  dispatcher:
    labels:
      org.omarchy-pool.agent.host: \"h_test\"
      org.omarchy-pool.agent.set: \"host\"
      org.omarchy-pool.agent.service: \"dispatcher\"
      org.omarchy-pool.agent.release: \"v1.0.0\"
      org.omarchy-pool.agent.inputs: \"sha256:00\"
";

fn one(files: &[(&str, &str)]) -> Result<Rendered, String> {
    let sources: Vec<Source> = files
        .iter()
        .map(|(name, text)| Source { name, text })
        .collect();
    let mut r = render("omarchy-host", Path::new(DIR), &sources, &env())?;
    assert_eq!(r.len(), 1);
    Ok(r.remove(0))
}

fn host(extra: &str) -> Result<Rendered, String> {
    let compose = crate::run::fake::rendered_compose(extra);
    one(&[("compose.yml", &compose), ("agent.yml", OVERLAY)])
}

/// The template with `items` added to the dispatcher's volumes and `top` at its end.
fn with_volumes(items: &str, top: &str) -> String {
    let capacity = "      - ./run/capacity.json:/run/omarchy/capacity.json:ro\n";
    let compose = crate::run::fake::rendered_compose(top);
    assert!(compose.contains(capacity));
    compose.replacen(capacity, &format!("{capacity}{items}"), 1)
}

/// A unit value split as systemd splits `ExecStart` (quotes and C escapes), `$$` and `%%`
/// then resolved: what podman is finally given.
pub(crate) fn systemd_words(v: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Option<String> = None;
    let mut chars = v.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match (c, quote) {
            ('"' | '\'', None) => {
                quote = Some(c);
                cur.get_or_insert_with(String::new);
            }
            (q, Some(open)) if q == open => quote = None,
            ('\\', _) => {
                let s = cur.get_or_insert_with(String::new);
                match chars.next() {
                    Some('n') => s.push('\n'),
                    Some('t') => s.push('\t'),
                    Some('r') => s.push('\r'),
                    Some('x') => {
                        let hex: String = chars.by_ref().take(2).collect();
                        s.push(char::from(u8::from_str_radix(&hex, 16).unwrap()));
                    }
                    Some(other) => s.push(other),
                    None => {}
                }
            }
            (c, None) if c.is_whitespace() => {
                if let Some(w) = cur.take() {
                    out.push(w);
                }
            }
            (c, _) => cur.get_or_insert_with(String::new).push(c),
        }
    }
    out.extend(cur);
    out.into_iter()
        .map(|w| {
            w.replace("$$", "\u{0}")
                .replace("%%", "%")
                .replace('\u{0}', "$")
        })
        .collect()
}

/// The values of `key=` lines of the unit, each split as systemd would.
fn values(text: &str, key: &str) -> Vec<Vec<String>> {
    text.lines()
        .filter_map(|l| l.strip_prefix(&format!("{key}=")))
        .map(systemd_words)
        .collect()
}

fn flat(text: &str, key: &str) -> Vec<String> {
    values(text, key).into_iter().flatten().collect()
}

#[test]
fn the_host_set_renders_field_by_field() {
    let r = host("").unwrap();
    let m = crate::verify::tests_support::manifest_json("v1.0.0", "v1.0.0", &[]);
    let worker = format!(
        "{}@{}",
        m["inner"]["images"]["worker"]["repo"].as_str().unwrap(),
        m["inner"]["images"]["worker"]["index"].as_str().unwrap()
    );
    assert_eq!(r.service, "dispatcher");
    assert_eq!(r.name, "omarchy-host-dispatcher");
    assert_eq!(r.image, worker);
    let t = &r.text;
    for line in [
        "[Unit]",
        "Wants=podman.socket",
        "After=podman.socket",
        "StartLimitIntervalSec=0",
        "[Container]",
        "ContainerName=omarchy-host-dispatcher",
        &format!("Image={worker}"),
        "Pull=never",
        "EnvironmentFile=\"/srv/set/etc/dispatcher.env\"",
        "Volume=/run/user/1000/podman/podman.sock:/var/run/docker.sock",
        "Volume=/srv/work:/srv/work",
        "Volume=/srv/set/run/capacity.json:/run/omarchy/capacity.json:ro",
        // Its own token file, read-only (#327): a path, never the token.
        "Volume=/srv/set/run/host/dispatcher/token:/run/omarchy/worker-token:ro",
        "PodmanArgs=\"--stop-timeout=60\"",
        "[Service]",
        "Restart=always",
        "RestartSec=1",
        "TimeoutStopSec=90",
        "[Install]",
        "WantedBy=default.target",
    ] {
        assert!(t.lines().any(|l| l == line), "{line:?} missing:\n{t}");
    }
    // Never podman's own updates: the agent moves a host, behind its guard.
    assert!(!t.contains("AutoUpdate"), "{t}");
    // No command: the image's own.
    assert!(!t.contains("\nExec="), "{t}");
    assert_eq!(
        flat(t, "Label"),
        [
            "org.omarchy-pool.agent.host=h_test".to_owned(),
            "org.omarchy-pool.agent.inputs=sha256:00".into(),
            "org.omarchy-pool.agent.release=v1.0.0".into(),
            "org.omarchy-pool.agent.service=dispatcher".into(),
            "org.omarchy-pool.agent.set=host".into(),
            "org.omarchy-pool.role=dispatcher".into(),
            format!("{HASH_LABEL}={}", r.hash),
        ]
    );
    let b = &m["inner"]["images"]["build"];
    assert_eq!(
        flat(t, "Environment"),
        [
            format!(
                "OMARCHY_BUILD_IMAGE_AARCH64={}",
                b["aarch64"].as_str().unwrap()
            ),
            format!(
                "OMARCHY_BUILD_IMAGE_X86_64={}",
                b["x86_64"].as_str().unwrap()
            ),
            "OMARCHY_CAPACITY_FILE=/run/omarchy/capacity.json".into(),
            "OMARCHY_SECRETS_DIR=/srv/secrets".into(),
            // The template's default: agent.toml sets none here.
            "OMARCHY_TASK_SUBNETS=10.231.0.0/16".into(),
            format!("OMARCHY_WORKER_IMAGE={worker}"),
            "OMARCHY_WORKER_ROLE=dispatcher".into(),
            "OMARCHY_WORKER_TOKEN_FILE=/run/omarchy/worker-token".into(),
            "OMARCHY_WORK_ROOT=/srv/work".into(),
        ]
    );
    // No token in the unit or the environment it gives: the file's path alone.
    assert!(
        !t.contains("OMARCHY_WORKER_TOKEN=") && !t.contains("omw_"),
        "{t}"
    );
    // The secrets directory is a path the dispatcher is told, never a mount.
    assert!(
        !flat(t, "Volume").iter().any(|v| v.contains("/srv/secrets")),
        "{t}"
    );
}

#[test]
fn the_hash_follows_what_runs_and_nothing_else() {
    let a = host("").unwrap();
    assert_eq!(host("").unwrap(), a, "one set, one unit");
    // The hash is the label's, and hashes the unit without the label or the comments.
    let unlabelled: Vec<&str> = a
        .text
        .lines()
        .filter(|l| !l.starts_with('#') && !l.contains(HASH_LABEL))
        .collect();
    assert_eq!(
        a.hash,
        hex::encode(Sha256::digest(unlabelled.join("\n").as_bytes()))
    );
    // An input that changes (the overlay's inputs label: a new token, capacity.json)
    // changes it; so does an owner's override.
    let compose = crate::run::fake::rendered_compose("");
    let moved = one(&[
        ("compose.yml", &compose),
        ("agent.yml", &OVERLAY.replace("sha256:00", "sha256:01")),
    ])
    .unwrap();
    assert_ne!(moved.hash, a.hash);
    let over =
        "services:\n  dispatcher:\n    environment:\n      OMARCHY_TASK_SUBNETS: 10.232.0.0/16\n";
    let o = one(&[
        ("compose.yml", &compose),
        ("agent.yml", OVERLAY),
        ("compose.override.yml", over),
    ])
    .unwrap();
    assert_ne!(o.hash, a.hash);
    assert!(
        o.text.contains("\"OMARCHY_TASK_SUBNETS=10.232.0.0/16\""),
        "{}",
        o.text
    );
    // The same variables said again, in another order, are the same unit.
    let reordered = "services:\n  dispatcher:\n    environment:\n      OMARCHY_WORKER_ROLE: dispatcher\n      OMARCHY_CAPACITY_FILE: /run/omarchy/capacity.json\n";
    let r = one(&[
        ("compose.yml", &compose),
        ("agent.yml", OVERLAY),
        ("compose.override.yml", reordered),
    ])
    .unwrap();
    assert_eq!(r.hash, a.hash);
}

#[test]
fn an_override_merges_as_compose_merges_it() {
    let compose = crate::run::fake::rendered_compose("    command: [serve, --old]\n");
    let over = "services:
  dispatcher:
    env_file: [etc/dispatcher.env, {path: etc/extra.env, required: false}]
    volumes:
      - /srv/other/capacity.json:/run/omarchy/capacity.json:ro
      - /srv/cache:/srv/cache
    labels: {org.omarchy-pool.role: dispatcher, owner.note: kept}
    command: [serve, --new]
    security_opt: [label=disable]
    stop_grace_period: 1m30s
    user: \"1000:1000\"
";
    let r = one(&[
        ("compose.yml", &compose),
        ("agent.yml", OVERLAY),
        ("compose.override.yml", over),
    ])
    .unwrap();
    let t = &r.text;
    // Mounted at the same target: the override's replaces the template's, in its place.
    assert_eq!(
        flat(t, "Volume"),
        [
            "/run/user/1000/podman/podman.sock:/var/run/docker.sock",
            "/srv/work:/srv/work",
            "/srv/other/capacity.json:/run/omarchy/capacity.json:ro",
            "/srv/set/run/host/dispatcher/token:/run/omarchy/worker-token:ro",
            "/srv/cache:/srv/cache",
        ]
    );
    // The same env file once; one that need not be there and is not, left out.
    assert_eq!(flat(t, "EnvironmentFile"), ["/srv/set/etc/dispatcher.env"]);
    assert!(flat(t, "Label").iter().any(|l| l == "owner.note=kept"));
    // A command is replaced, never appended to.
    assert_eq!(flat(t, "Exec"), ["serve", "--new"]);
    for line in [
        "SecurityLabelDisable=true",
        "User=1000:1000",
        "PodmanArgs=\"--stop-timeout=90\"",
        "TimeoutStopSec=120",
    ] {
        assert!(t.lines().any(|l| l == line), "{line:?} missing:\n{t}");
    }
}

#[test]
fn the_entrypoint_and_command_reach_podman_as_compose_gives_them() {
    // The run loop's stand-in (`run::engine_tests`): a list entrypoint whose script holds
    // compose's `$$`, quotes, a `%`, a backslash and newlines, then a command.
    let script = "set -eu\nroot=\"$${OMARCHY_WORK_ROOT}\"\necho \"100% \\\\ $$(hostname)\"\n";
    let extra = format!(
        "    entrypoint:\n      - sh\n      - -c\n      - |\n{}      - standin\n    command: [ok]\n",
        script.lines().fold(String::new(), |mut out, l| {
            out.push_str("        ");
            out.push_str(l);
            out.push('\n');
            out
        })
    );
    let r = host(&extra).unwrap();
    assert_eq!(
        flat(&r.text, "PodmanArgs"),
        ["--stop-timeout=60", "--entrypoint=sh"]
    );
    // What compose would run once it read `$$` as `$`: sh -c <script> standin ok.
    assert_eq!(
        flat(&r.text, "Exec"),
        [
            "-c",
            "set -eu\nroot=\"${OMARCHY_WORK_ROOT}\"\necho \"100% \\\\ $(hostname)\"\n",
            "standin",
            "ok"
        ]
    );
    // One line each: a unit file holds no raw newline in a value.
    assert!(
        r.text.lines().all(|l| !l.starts_with("root=")),
        "{}",
        r.text
    );
    // An entrypoint given as an empty list replaces the image's with none; a string
    // command is split at its blanks.
    let r = host("    entrypoint: []\n    command: \"serve  --fast\"\n").unwrap();
    assert_eq!(
        flat(&r.text, "PodmanArgs"),
        ["--stop-timeout=60", "--entrypoint="]
    );
    assert_eq!(flat(&r.text, "Exec"), ["serve", "--fast"]);
}

#[test]
fn interpolation_is_compose_s_with_agent_toml_s_variables_only() {
    let env: Vec<(String, String)> =
        vec![("A".into(), "a".into()), ("EMPTY".into(), String::new())];
    for (src, want) in [
        ("$$A", "$A"),
        ("$A/${A}", "a/a"),
        ("${B:-dflt}", "dflt"),
        ("${EMPTY:-dflt}", "dflt"),
        ("${EMPTY-dflt}", ""),
        ("${B-${A}x}", "ax"),
        ("${A:+alt}", "alt"),
        ("${EMPTY:+alt}", ""),
        ("${EMPTY+alt}", "alt"),
        ("${B+alt}", ""),
        ("${A:?gone}", "a"),
        ("100%", "100%"),
    ] {
        assert_eq!(interpolate(src, &env).unwrap(), want, "{src}");
    }
    for (src, why) in [
        ("${B}", "is not set"),
        ("$B", "is not set"),
        ("${B:?the socket}", "the socket"),
        ("${EMPTY:?empty}", "empty"),
        ("${A", "without its }"),
        ("cost $5", "neither $$ nor a variable"),
        ("${1A}", "not a variable name"),
        ("${A/x/y}", "not a form"),
        ("${A€x}", "not a form"),
    ] {
        let e = interpolate(src, &env).unwrap_err();
        assert!(e.contains(why), "{src}: {e}");
    }
    // An unset variable stops the render (compose would put a blank string there).
    let e = host("    user: ${OMARCHY_UID}\n").unwrap_err();
    assert!(e.contains("${OMARCHY_UID} is not set"), "{e}");
    // Defaults nested as deep as a set would nest them are read; an override nesting them
    // thousands deep is refused, never recursed into until the stack runs out.
    let nest = |n: usize| format!("{}x{}", "${B:-".repeat(n), "}".repeat(n));
    assert_eq!(interpolate(&nest(MAX_NESTING), &env).unwrap(), "x");
    for n in [MAX_NESTING + 2, 20_000] {
        let e = interpolate(&nest(n), &env).unwrap_err();
        assert!(e.contains("nested deeper than 16"), "{n}: {e}");
    }
    let e = host(&format!("    user: \"{}\"\n", nest(20_000))).unwrap_err();
    assert!(e.contains("nested deeper"), "{e}");
}

#[test]
fn the_driver_needs_a_podman_whose_quadlet_reads_every_key_it_writes() {
    for v in ["4.6.0", "4.6.2", "4.9.3", "5.0.0-rc1", "5.4.2", "10.0"] {
        assert_eq!(podman_refused(v), None, "{v}");
    }
    // Pull= and PodmanArgs= came in 4.6: an older generator makes no service of the unit.
    for v in ["4.5.1", "4.4.1", "3.4.4"] {
        let e = podman_refused(v).unwrap();
        assert!(e.contains(&format!("podman {v} is older than 4.6")), "{e}");
    }
    for v in ["", "v4.9", "4", "dev"] {
        assert!(
            podman_refused(v).unwrap().contains("does not read"),
            "{v:?}"
        );
    }
    // What the renderer writes is what needs 4.6.
    let r = host("").unwrap();
    assert!(r.text.contains("\nPull=never\n") && r.text.contains("\nPodmanArgs="));
}

#[test]
fn named_volumes_tmpfs_and_anonymous_volumes() {
    let compose = with_volumes(
        "      - cache:/var/cache/pacman\n      - /scratch\n      - {type: tmpfs, target: /tmp}\n      - {type: volume, source: cache, target: /cache, read_only: true}\n      - {type: bind, source: ./run, target: /srv/run}\n",
        "volumes:\n  cache: {labels: {owner: me}}\n",
    );
    let r = one(&[("compose.yml", &compose), ("agent.yml", OVERLAY)]).unwrap();
    assert_eq!(
        &flat(&r.text, "Volume")[3..],
        [
            "omarchy-host_cache:/var/cache/pacman",
            "/scratch",
            "omarchy-host_cache:/cache:ro",
            "/srv/set/run:/srv/run",
            "/srv/set/run/host/dispatcher/token:/run/omarchy/worker-token:ro",
        ]
    );
    assert_eq!(flat(&r.text, "Tmpfs"), ["/tmp"]);
}

#[test]
fn the_token_file_is_a_read_only_bind_podman_never_creates() {
    // #327's long-syntax bind renders as the short one would: the file, read-only.
    let token = "Volume=/srv/set/run/host/dispatcher/token:/run/omarchy/worker-token:ro";
    let long = host("").unwrap();
    assert!(long.text.lines().any(|l| l == token), "{}", long.text);
    let short = crate::run::fake::rendered_compose("").replace(
        "      - type: bind\n        source: ./run/host/dispatcher/token\n        target: /run/omarchy/worker-token\n        read_only: true\n        bind: { create_host_path: false }\n",
        "      - ./run/host/dispatcher/token:/run/omarchy/worker-token:ro\n",
    );
    assert!(!short.contains("create_host_path"), "the template changed");
    let r = one(&[("compose.yml", &short), ("agent.yml", OVERLAY)]).unwrap();
    assert_eq!(r.text, long.text);
    // podman never makes a bind's missing source (it stops: `statfs <source>: no such file
    // or directory`), which is what `create_host_path: false` asks: a unit cannot make the
    // directory `true` asks for, nor carry a bind option outside the subset.
    for (bind, why) in [
        (
            "{ create_host_path: true }",
            "create_host_path: true is not rendered for Quadlet",
        ),
        (
            "{ propagation: rshared }",
            "bind propagation is outside the subset",
        ),
        (
            "{ create_host_path: maybe }",
            "bind create_host_path is outside the subset",
        ),
        ("[create_host_path]", "bind is not a mapping"),
    ] {
        let compose = crate::run::fake::rendered_compose("").replace(
            "bind: { create_host_path: false }",
            &format!("bind: {bind}"),
        );
        let e = one(&[("compose.yml", &compose), ("agent.yml", OVERLAY)]).unwrap_err();
        assert!(
            e.starts_with("dispatcher: volume ") && e.contains(why),
            "{bind}: {e}"
        );
    }
    let named = with_volumes(
        "      - {type: volume, source: cache, target: /c, bind: {create_host_path: false}}\n",
        "volumes:\n  cache: {}\n",
    );
    let e = one(&[("compose.yml", &named)]).unwrap_err();
    assert!(e.contains("bind options on what is not a bind"), "{e}");
}

#[test]
fn what_one_rootless_service_cannot_mean_as_compose_does_is_refused_by_name() {
    for (extra, why) in [
        (
            "    networks: [default]\n",
            "networks is not rendered for Quadlet",
        ),
        ("    depends_on: [db]\n", "depends_on is not rendered"),
        ("    profiles: [debug]\n", "profiles is not rendered"),
        (
            "    ports: [\"80:80\"]\n",
            "ports is not in the template subset",
        ),
        ("    restart: on-failure:3\n", "restart \"on-failure:3\""),
        ("    command: sh -c 'echo hi'\n", "give it as a list"),
        ("    entrypoint: [\"[sh]\"]\n", "read it as JSON"),
        (
            "    security_opt: [seccomp=unconfined]\n",
            "only label=disable",
        ),
        ("    stop_grace_period: soon\n", "not a duration"),
        (
            "    stop_signal: \"SIGTERM; rm\"\n",
            "not a value this driver passes on",
        ),
        (
            "    user: \"root --privileged\"\n",
            "not a value this driver passes on",
        ),
        (
            "    platform: \"linux/amd64 --rm\"\n",
            "not a value this driver passes on",
        ),
    ] {
        // The template's restart line comes before: the extra one is a duplicate key.
        // In place of the template's own line for that field, if it has one.
        let key = format!("    {}:", extra.trim_start().split(':').next().unwrap());
        let compose = crate::run::fake::rendered_compose("")
            .lines()
            .filter(|l| !l.starts_with(&key))
            .fold(String::new(), |out, l| out + l + "\n")
            + extra;
        let e = one(&[("compose.yml", &compose)]).unwrap_err();
        assert!(
            e.starts_with("dispatcher: ") && e.contains(why),
            "{extra}: {e}"
        );
    }
    // Volumes compose would not read the same way here.
    for (vol, why) in [
        ("      - ~/cache:/cache\n", "no home-relative bind"),
        (
            "      - cache:/cache\n",
            "not declared under the top-level volumes",
        ),
        ("      - ./../../etc:/etc\n", "leaves the set directory"),
        ("      - /srv/x:/srv/x:cached\n", "option \"cached\""),
        ("      - /srv/x:relative\n", "not an absolute path"),
        ("      - /srv/a\"b:/srv/b\n", "not a value a unit holds"),
    ] {
        let compose = with_volumes(vol, "");
        let e = one(&[("compose.yml", &compose)]).unwrap_err();
        assert!(e.contains(why), "{vol}: {e}");
    }
    let e = one(&[("compose.yml", "services: []\n")]).unwrap_err();
    assert!(e.contains("no services mapping"), "{e}");
}

#[test]
fn values_are_escaped_for_the_unit_and_its_exec_start() {
    // A word Quadlet splits: quoted, with C escapes, `$$` and `%%`.
    assert_eq!(word("a b"), "\"a b\"");
    assert_eq!(
        word("say \"hi\"\n\\ $HOME 50% \u{1}"),
        "\"say \\\"hi\\\"\\n\\\\ $$HOME 50%% \\x01\""
    );
    for w in [
        "plain",
        "a b",
        "q\"uote",
        "nl\nnl",
        "$$x",
        "%h",
        "back\\slash",
        "tab\t.",
    ] {
        assert_eq!(systemd_words(&word(w)), [w], "{w:?}");
    }
    // A value Quadlet takes whole: as written, `%` and `$` doubled, nothing that reads as
    // something else.
    assert_eq!(raw("Volume", "/a b/%x:/c").unwrap(), "/a b/%%x:/c");
    for bad in ["", " lead", "trail ", "q\"", "back\\", "nl\n"] {
        assert!(raw("Volume", bad).is_err(), "{bad:?}");
    }
}

#[test]
fn durations_and_restart_policies() {
    for (d, s) in [
        ("60s", 60),
        ("1m30s", 90),
        ("1.5s", 2),
        ("3h", 10_800),
        ("500ms", 1),
        ("90", 90),
        ("1h2m3s", 3723),
    ] {
        assert_eq!(seconds(d).unwrap(), s, "{d}");
    }
    for bad in ["", "s", "1x", "-1s", "1.2.3s"] {
        assert!(seconds(bad).is_err(), "{bad:?}");
    }
    let compose = crate::run::fake::rendered_compose("");
    let no = one(&[(
        "compose.yml",
        &compose.replace("restart: unless-stopped", "restart: \"no\""),
    )])
    .unwrap();
    assert!(no.text.lines().any(|l| l == "Restart=no"), "{}", no.text);
    // Not started at login either: compose's `no` brings nothing back after a reboot.
    assert!(!no.text.contains("[Install]"), "{}", no.text);
    let always = one(&[(
        "compose.yml",
        &compose.replace("restart: unless-stopped", "restart: always"),
    )])
    .unwrap();
    assert!(always.text.contains("Restart=always\n"), "{}", always.text);
}

#[test]
fn unit_names_always_begin_with_omarchy() {
    assert_eq!(
        unit_name("omarchy-host", "dispatcher"),
        "omarchy-host-dispatcher"
    );
    assert_eq!(unit_name("it-42", "dispatcher"), "omarchy-it-42-dispatcher");
}

/// podman's generator (`quadlet -dryrun -user`) reads the rendered host set — the template
/// as release.yml renders it, the overlay, and a stand-in's script — and the `podman run`
/// it writes carries what compose would run: the image, the name, the mounts, the env
/// file, the stop timeout, the labels, and the stand-in's argv.
#[test]
#[ignore = "needs podman's quadlet generator: tests/agent-quadlet.sh"]
fn the_generator_reads_the_rendered_host_set() {
    let quadlet =
        std::env::var("OMARCHY_QUADLET").unwrap_or_else(|_| "/usr/libexec/podman/quadlet".into());
    let extra = "    entrypoint:\n      - sh\n      - -c\n      - |\n        echo \"$${OMARCHY_WORK_ROOT} 100%\" >&2\n        exec sleep 1\n      - standin\n    command: [ok]\n";
    let r = host(extra).unwrap();
    let dir = crate::run::state::tempdir();
    std::fs::write(dir.join(format!("{}.container", r.name)), &r.text).unwrap();
    let out = std::process::Command::new(&quadlet)
        .args(["-dryrun", "-user"])
        .env("QUADLET_UNIT_DIRS", &dir)
        .output()
        .unwrap_or_else(|e| panic!("{quadlet}: {e}"));
    let _ = std::fs::remove_dir_all(&dir);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{stderr}");
    assert!(
        !stderr.contains("unsupported") && !stderr.contains("rror"),
        "{stderr}"
    );
    assert!(
        stdout.contains(&format!("---{}.service---", r.name)),
        "{stdout}\n{stderr}"
    );
    let exec = stdout
        .lines()
        .find_map(|l| l.strip_prefix("ExecStart="))
        .unwrap_or_else(|| panic!("no ExecStart:\n{stdout}"));
    let argv = systemd_words(exec);
    let has = |w: &str| argv.iter().any(|a| a == w);
    let pair = |a: &str, b: &str| argv.windows(2).any(|p| p[0] == a && p[1] == b);
    assert!(has("--name=omarchy-host-dispatcher"), "{argv:?}");
    assert!(pair("--pull", "never"), "{argv:?}");
    assert!(
        has("--rm") && has("--stop-timeout=60") && has("--entrypoint=sh"),
        "{argv:?}"
    );
    for v in [
        "/run/user/1000/podman/podman.sock:/var/run/docker.sock",
        "/srv/work:/srv/work",
        "/srv/set/run/capacity.json:/run/omarchy/capacity.json:ro",
        // The token's own file, read-only (#327): `-v`, which never creates a source.
        "/srv/set/run/host/dispatcher/token:/run/omarchy/worker-token:ro",
    ] {
        assert!(pair("-v", v), "{v}: {argv:?}");
    }
    assert!(
        pair("--env-file", "/srv/set/etc/dispatcher.env"),
        "{argv:?}"
    );
    assert!(pair("--env", "OMARCHY_WORK_ROOT=/srv/work"), "{argv:?}");
    assert!(
        pair(
            "--env",
            "OMARCHY_WORKER_TOKEN_FILE=/run/omarchy/worker-token"
        ) && !argv.iter().any(|a| a.starts_with("OMARCHY_WORKER_TOKEN=")),
        "{argv:?}"
    );
    assert!(
        pair("--label", &format!("{HASH_LABEL}={}", r.hash)),
        "{argv:?}"
    );
    assert!(!argv.iter().any(|a| a.contains("auto-update")), "{argv:?}");
    // After the image, the stand-in's argv exactly as compose would give it.
    let at = argv.iter().position(|a| *a == r.image).expect("the image");
    assert_eq!(
        &argv[at + 1..],
        [
            "-c",
            "echo \"${OMARCHY_WORK_ROOT} 100%\" >&2\nexec sleep 1\n",
            "standin",
            "ok"
        ]
    );
    assert!(
        stdout.contains("Restart=always") && stdout.contains("WantedBy=default.target"),
        "{stdout}"
    );
}
