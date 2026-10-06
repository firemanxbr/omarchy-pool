use std::path::{Path, PathBuf};

use std::collections::BTreeMap;

use super::{
    lint_compose, lint_set_toml, parse_set_toml, reads_token_file, references, secret_files,
    token_file_of, Engine, Envelope, Needs, Ready, Reference, SetToml, Violation,
};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lint")
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(fixtures().join(rel)).unwrap()
}

fn envelope(name: &str) -> Envelope {
    Envelope::from_agent_toml(&read(&format!("envelope/{name}.toml"))).unwrap()
}

/// `<dir>/compose.yml` with `over` merged onto it, and `<dir>/set.toml` against the
/// template, as `lint-set <dir> --override` reads them.
fn lint_set(
    dir: &Path,
    over: Option<&Path>,
    envelope: &Envelope,
    engine: Engine,
) -> Result<(), Vec<Violation>> {
    let read = |p: &Path| std::fs::read_to_string(p).unwrap();
    let template = read(&dir.join("compose.yml"));
    let over = over.map(read);
    let mut violations = lint_compose(&template, over.as_deref(), envelope, engine)
        .err()
        .unwrap_or_default();
    violations.extend(
        lint_set_toml(&read(&dir.join("set.toml")), &template)
            .err()
            .unwrap_or_default(),
    );
    if violations.is_empty() {
        Ok(())
    } else {
        Err(violations)
    }
}

const HOST: &str = include_str!("../../tests/fixtures/lint/host/compose.yml");

/// The real `factory/sets/host`, as release.yml and CI lint it: read at run time, so the
/// crate builds without it.
fn real_set(file: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../factory/sets/host")
        .join(file);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// `from` replaced once by `to`, and it must be there.
fn mutate(text: &str, from: &str, to: &str) -> String {
    assert!(text.contains(from), "{from:?} is not in the template");
    text.replacen(from, to, 1)
}

fn rules(result: Result<(), Vec<Violation>>) -> Vec<&'static str> {
    result
        .err()
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.rule)
        .collect()
}

/// Refused with exactly `rule` (and nothing else). A second service is also checked as a
/// service of its own, so it may break more than the one rule.
fn refused_for(result: Result<(), Vec<Violation>>, rule: &str, case: &str) {
    let got = rules(result);
    if rule == "services" {
        assert_eq!(got.first(), Some(&"services"), "{case}: {got:?}");
    } else {
        // Only `rule`, once per offending key (both build images missing are two).
        assert!(
            !got.is_empty() && got.iter().all(|r| *r == rule),
            "{case}: {got:?}"
        );
    }
}

#[test]
fn the_host_set_template_passes_under_the_reference_and_the_studio_envelopes() {
    lint_compose(HOST, None, &Envelope::reference(), Engine::Rootful).unwrap();
    lint_set(
        &fixtures().join("host"),
        None,
        &envelope("studio"),
        Engine::Rootful,
    )
    .unwrap();
}

#[test]
fn an_image_digest_is_refused_the_lint_runs_before_rendering() {
    // The template rendered, and an override pinning an older (or revoked) worker image.
    let digest = format!(
        "ghcr.io/firemanxbr/omarchy-worker@sha256:{}",
        "0".repeat(64)
    );
    let rendered = HOST.replace("ghcr.io/firemanxbr/omarchy-worker@RELEASE@", &digest);
    refused_for(
        lint_compose(&rendered, None, &Envelope::reference(), Engine::Rootful),
        "image",
        "rendered template",
    );
    let over = format!("services:\n  dispatcher:\n    image: {digest}\n");
    refused_for(
        lint_compose(HOST, Some(&over), &Envelope::reference(), Engine::Rootful),
        "image",
        "override digest",
    );
}

#[test]
fn each_acceptance_case_is_refused_in_the_template() {
    for (file, rule) in [
        ("second-service", "services"),
        ("no-role", "role"),
        ("anthropic-key", "secret_interpolation"),
        ("github-token", "secret_interpolation"),
        ("secrets-mount", "secrets_mount"),
        ("other-secret-file", "secret_file"),
        ("no-build-images", "build_images"),
    ] {
        let template = read(&format!("template/{file}.yml"));
        refused_for(
            lint_compose(&template, None, &Envelope::reference(), Engine::Rootful),
            rule,
            file,
        );
    }
    // The socket without allow_socket.
    refused_for(
        lint_set(
            &fixtures().join("host"),
            None,
            &envelope("no-socket"),
            Engine::Rootful,
        ),
        "socket",
        "socket",
    );
}

#[test]
fn each_acceptance_case_is_refused_through_an_override() {
    for (file, rule) in [
        ("second-service", "services"),
        ("no-role", "role"),
        ("anthropic-key", "secret_interpolation"),
        ("github-token", "secret_interpolation"),
        ("secrets-mount", "secrets_mount"),
        ("other-secret-file", "secret_file"),
        ("build-image-tag", "build_images"),
    ] {
        let over = fixtures().join(format!("override/{file}.yml"));
        refused_for(
            lint_set(
                &fixtures().join("host"),
                Some(&over),
                &Envelope::reference(),
                Engine::Rootful,
            ),
            rule,
            file,
        );
    }
    // A template without the socket passes that envelope; an override adding it does not.
    let base = fixtures().join("host-no-socket");
    lint_set(&base, None, &envelope("no-socket"), Engine::Rootful).unwrap();
    let over = fixtures().join("override/socket.yml");
    refused_for(
        lint_set(&base, Some(&over), &envelope("no-socket"), Engine::Rootful),
        "socket",
        "socket override",
    );
}

#[test]
fn the_socket_needs_rootful_ack_and_dedicated_on_a_rootful_engine() {
    let mut e = Envelope::reference();
    e.dedicated = false;
    refused_for(
        lint_compose(HOST, None, &e, Engine::Rootful),
        "socket",
        "not dedicated",
    );
    lint_compose(HOST, None, &e, Engine::Rootless).unwrap();
    e.allow_socket = false;
    refused_for(
        lint_compose(HOST, None, &e, Engine::Rootless),
        "socket",
        "rootless without allow_socket",
    );
}

#[test]
fn every_other_invariant_is_refused_through_an_override_with_its_rule() {
    let svc = |body: &str| format!("services:\n  dispatcher:\n{body}");
    let cases: Vec<(String, &str)> = vec![
        (svc("    build: .\n"), "field"),
        (svc("    ports: [\"8080:8080\"]\n"), "field"),
        (svc("    devices: [/dev/kvm]\n"), "field"),
        (svc("    privileged: true\n"), "field"),
        (svc("    cap_add: [SYS_ADMIN]\n"), "field"),
        (svc("    pid: host\n"), "field"),
        (svc("    ipc: host\n"), "field"),
        (svc("    network_mode: host\n"), "field"),
        (svc("    healthcheck: {test: [CMD, true]}\n"), "field"),
        (svc("    security_opt: [seccomp=unconfined]\n"), "field"),
        (svc("    userns_mode: host\n"), "userns_mode"),
        (svc("    image: docker.io/library/alpine:latest\n"), "image"),
        (svc("    image: ghcr.io/firemanxbr/omarchy-worker:latest\n"), "image"),
        (svc("    env_file: [etc/agent.env]\n"), "env_file"),
        (svc("    environment: {OMARCHY_EXTRA: x}\n"), "environment"),
        (svc("    environment: [GITHUB_TOKEN]\n"), "environment"),
        (svc("    volumes: [\"/etc:/host-etc\"]\n"), "bind_path"),
        (svc("    volumes: [\"../..:/up\"]\n"), "bind_path"),
        (svc("    volumes: [\"~/.ssh:/ssh\"]\n"), "bind_path"),
        (svc("    volumes: [\"${OMARCHY_WORK_ROOT:-/}:/w\"]\n"), "bind_path"),
        (svc("    volumes: [\"${HOME}:/home\"]\n"), "bind_path"),
        (svc("    volumes: [\"${OMARCHY_WORK_ROOT}/../..:/w\"]\n"), "bind_path"),
        (svc("    volumes: [{type: npipe, source: x, target: /x}]\n"), "bind_path"),
        (svc("    volumes: [{type: bind, source: ./x, target: /x, bind: {propagation: rshared}}]\n"), "bind_path"),
        ("volumes:\n  data: {driver_opts: {type: none, o: bind, device: /}}\n".into(), "volume"),
        ("volumes:\n  data: {external: true, name: other_project_data}\n".into(), "volume"),
        ("networks:\n  host: {external: true}\n".into(), "network"),
        ("include: [../other/compose.yml]\n".into(), "top_level"),
        ("name: another-project\n".into(), "top_level"),
        (svc("    labels: !reset {}\n"), "yaml"),
        (svc("    <<: {privileged: true}\n"), "yaml"),
    ];
    for (over, rule) in cases {
        refused_for(
            lint_compose(HOST, Some(&over), &Envelope::reference(), Engine::Rootful),
            rule,
            &over,
        );
    }
}

#[test]
fn what_the_owner_may_change_passes() {
    let mut e = envelope("studio");
    for over in [
        "services:\n  dispatcher:\n    restart: always\n    stop_grace_period: 90s\n",
        "services:\n  dispatcher:\n    volumes: [\"/srv/omarchy-pool/host/cache:/cache\", \"./etc/extra.conf:/etc/extra.conf:ro\", \"cache:/var/cache\"]\nvolumes:\n  cache: {}\n",
        "services:\n  dispatcher:\n    environment: [OMARCHY_TASK_SUBNETS=10.240.0.0/16]\n    security_opt: [label=disable]\n",
        "services:\n  dispatcher:\n    networks: [tasks]\nnetworks:\n  tasks: {driver: bridge, internal: true}\n",
        "x-note: &n {a: 1}\nx-other: *n\n",
    ] {
        lint_compose(HOST, Some(over), &e, Engine::Rootful).unwrap_or_else(|v| panic!("{over}: {v:?}"));
    }
    // userns_mode: host only with userns_remap recorded.
    let over = "services:\n  dispatcher:\n    userns_mode: host\n";
    e.userns_remap = true;
    lint_compose(HOST, Some(over), &e, Engine::Rootful).unwrap();
    // A host path the envelope lists, but that holds the secrets directory, is refused.
    let over = "services:\n  dispatcher:\n    volumes: [\"/srv/omarchy-pool:/pool\"]\n";
    refused_for(
        lint_compose(HOST, Some(over), &envelope("studio"), Engine::Rootful),
        "secrets_mount",
        over,
    );
    let over =
        "services:\n  dispatcher:\n    volumes: [\"/srv/omarchy-pool/host-secrets:/s:ro\"]\n";
    refused_for(
        lint_compose(HOST, Some(over), &envelope("studio"), Engine::Rootful),
        "secrets_mount",
        over,
    );
}

#[test]
fn the_dispatcher_mounts_its_own_token_file_read_only_and_nothing_else_of_the_set_s_secrets() {
    // #327: run/host/<service>/token is that service's alone; the directories holding the
    // secret files, another service's file, and its own writable are refused, however the
    // path is spelt — and nothing under the secrets directory, as before.
    let svc = |body: &str| format!("services:\n  dispatcher:\n{body}");
    for (over, rule) in [
        (
            svc("    volumes: [\"./run/host/dispatcher/token:/t\"]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [\"./run/host/dispatcher/token:/t:rw\"]\n"),
            "secret_file",
        ),
        // Compose takes the last of ro and rw: writable.
        (
            svc("    volumes: [\"./run/host/dispatcher/token:/t:ro,rw\"]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [\"./run/host/dispatcher/token:/run/omarchy/worker-token:z,ro,rw\"]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [{type: bind, source: ./run/host/dispatcher/token, target: /t}]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [\"./run/host/agent/token:/t:ro\"]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [\"run/host/egress/token:/t:ro\"]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [\"./run/host/dispatcher/../agent/token:/t:ro\"]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [\"./run/host/dispatcher/token.old:/t:ro\"]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [\"./run/host/dispatcher:/d:ro\"]\n"),
            "secret_file",
        ),
        (svc("    volumes: [\"./run/host:/h:ro\"]\n"), "secret_file"),
        (svc("    volumes: [\"./run:/r:ro\"]\n"), "secret_file"),
        (svc("    volumes: [\".:/set:ro\"]\n"), "secret_file"),
        (
            svc("    volumes: [\"./etc/../run/host:/h:ro\"]\n"),
            "secret_file",
        ),
        (
            svc("    volumes: [\"${OMARCHY_SECRETS_DIR}/agent.env:/a:ro\"]\n"),
            "secrets_mount",
        ),
    ] {
        refused_for(
            lint_compose(HOST, Some(&over), &Envelope::reference(), Engine::Rootful),
            rule,
            &over,
        );
    }
    // By its absolute path, where the envelope knows the set directory: another service's
    // file, and a directory above the set's that the envelope lists.
    let mut e = envelope("studio");
    let set = "/home/omarchy/.local/share/omarchy-agent/sets/host";
    for over in [
        svc(&format!(
            "    volumes: [\"{set}/run/host/agent/token:/t:ro\"]\n"
        )),
        svc(&format!("    volumes: [\"{set}:/set:ro\"]\n")),
        svc("    volumes: [\"/home/omarchy/.local/share/omarchy-agent:/a:ro\"]\n"),
    ] {
        e.paths.push("/home/omarchy".into());
        refused_for(
            lint_compose(HOST, Some(&over), &e, Engine::Rootful),
            "secret_file",
            &over,
        );
    }
    // Its own file read-only, either syntax, passes; so does the rest of run/ and the set.
    for over in [
        svc("    volumes: [\"./run/host/dispatcher/token:/run/omarchy/worker-token:ro\"]\n"),
        svc("    volumes: [\"./run/host/dispatcher/token:/t:ro,z\"]\n"),
        svc("    volumes: [\"./run/host/dispatcher/token:/t:rw,ro\"]\n"),
        svc(&format!("    volumes: [\"{set}/run/host/dispatcher/token:/t:ro\"]\n")),
        svc("    volumes: [\"./run/capacity.json:/c:ro\", \"./etc/extra.conf:/e:ro\", \"./files:/f:ro\"]\n"),
    ] {
        lint_compose(HOST, Some(&over), &envelope("studio"), Engine::Rootful)
            .unwrap_or_else(|v| panic!("{over}: {v:?}"));
    }
    assert_eq!(token_file_of("dispatcher"), "run/host/dispatcher/token");
}

#[test]
fn a_template_from_before_the_token_file_passes_and_the_run_loop_reads_what_a_template_mounts() {
    // A template from before #327 — the token in etc/dispatcher.env, no file — still
    // passes: a rollback may name it.
    let older = mutate(
        &mutate(
            &real_set("compose.yml"),
            "      OMARCHY_WORKER_TOKEN_FILE: /run/omarchy/worker-token   # the host worker token, a read-only file (#327)\n",
            "",
        ),
        "      - type: bind\n        source: ./run/host/dispatcher/token\n        target: /run/omarchy/worker-token\n        read_only: true\n        bind: { create_host_path: false }\n",
        "",
    );
    lint_compose(&older, None, &Envelope::reference(), Engine::Rootful).unwrap();
    // But never with the token's value in its environment.
    let plain = mutate(
        &real_set("compose.yml"),
        "      OMARCHY_WORKER_TOKEN_FILE: /run/omarchy/worker-token",
        "      OMARCHY_WORKER_TOKEN: ${OMARCHY_WORKER_TOKEN}",
    );
    refused_for(
        lint_compose(&plain, None, &Envelope::reference(), Engine::Rootful),
        "environment",
        "the token's value in the environment",
    );

    // What the run loop reads of a template: whether it reads the token file, and the
    // secret files compose must find.
    let template = real_set("compose.yml");
    assert!(reads_token_file(&template) && reads_token_file(HOST));
    assert!(!reads_token_file(&older));
    assert!(!reads_token_file("not: [yaml"));
    assert_eq!(secret_files(&template), ["run/host/dispatcher/token"]);
    assert_eq!(secret_files(HOST), ["run/host/dispatcher/token"]);
    assert!(secret_files(&older).is_empty());
    assert_eq!(
        secret_files(&format!(
            "{HOST}      - ./run/host/dispatcher/../dispatcher/token:/again:ro\n"
        )),
        ["run/host/dispatcher/token"]
    );
}

#[test]
fn the_build_images_are_required() {
    // #312: a dispatcher without either variable is refused, in the template.
    for line in [
        "      OMARCHY_BUILD_IMAGE_AARCH64: \"@BUILD_AARCH64@\"\n",
        "      OMARCHY_BUILD_IMAGE_X86_64: \"@BUILD_X86_64@\"\n",
    ] {
        let without = HOST.replace(line, "");
        assert_ne!(without, HOST);
        refused_for(
            lint_compose(&without, None, &Envelope::reference(), Engine::Rootful),
            "build_images",
            line,
        );
    }
    // Emptied, swapped, or pointed at a tag — in an override as in the template: each would
    // leave pkg-repo on a tag no release pins.
    let svc = |var: &str, value: &str| {
        format!("services:\n  dispatcher:\n    environment:\n      {var}: {value}\n")
    };
    for over in [
        svc("OMARCHY_BUILD_IMAGE_X86_64", "\"\""),
        svc("OMARCHY_BUILD_IMAGE_X86_64", "null"),
        svc(
            "OMARCHY_BUILD_IMAGE_X86_64",
            "docker.io/library/archlinux:base-devel",
        ),
        svc("OMARCHY_BUILD_IMAGE_X86_64", "\"@BUILD_AARCH64@\""),
        svc(
            "OMARCHY_BUILD_IMAGE_AARCH64",
            "${OMARCHY_BUILD_IMAGE_AARCH64}",
        ),
        "services:\n  dispatcher:\n    environment: [OMARCHY_BUILD_IMAGE_AARCH64]\n".into(),
    ] {
        refused_for(
            lint_compose(HOST, Some(&over), &Envelope::reference(), Engine::Rootful),
            "build_images",
            &over,
        );
    }
}

#[test]
fn references_are_found_where_compose_would_interpolate() {
    let names = |s| {
        references(s)
            .into_iter()
            .map(|r| r.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(names("a ${A} $B $$C ${D:-${E}} $"), ["A", "B", "D", "E"]);
    assert_eq!(
        references("${A:-x}"),
        [Reference {
            name: "A",
            plain: false
        }]
    );
    assert_eq!(
        references("${A}"),
        [Reference {
            name: "A",
            plain: true
        }]
    );
    assert!(names("$$ANTHROPIC_API_KEY").is_empty());
}

#[test]
fn an_envelope_with_a_relative_path_is_refused() {
    assert!(Envelope::from_agent_toml("[envelope]\npaths = [\"srv\"]\n").is_err());
    let e = Envelope::from_agent_toml("").unwrap();
    assert!(!e.allow_socket && e.paths.is_empty());
}

#[test]
fn an_envelope_with_the_secrets_directory_inside_a_bound_directory_is_refused() {
    // The template binds the work root and the set directory; neither may hold the secrets.
    for (work_root, dir) in [
        ("/srv/omarchy-pool", "/srv/set"),
        ("/srv/omarchy-pool/host/secrets", "/srv/set"),
        ("/srv/omarchy-pool/host", "/srv/omarchy-pool/host"),
        ("/srv/work", "/srv/omarchy-pool"),
    ] {
        let toml = format!("[set]\ndir = \"{dir}\"\nwork_root = \"{work_root}\"\nsecrets_dir = \"/srv/omarchy-pool/host\"\n");
        assert!(Envelope::from_agent_toml(&toml).is_err(), "{toml}");
    }
    let toml = "[set]\ndir = \"/srv/set\"\nwork_root = \"/srv/omarchy-pool/host\"\nsecrets_dir = \"/srv/omarchy-pool/host-secrets\"\n";
    Envelope::from_agent_toml(toml).unwrap();
}

// ---------------------------------------------------------------------------------------
// The real host set (#310): factory/sets/host.

#[test]
fn the_real_host_set_passes_lint_set_under_the_reference_and_the_studio_envelopes() {
    let template = real_set("compose.yml");
    lint_compose(&template, None, &Envelope::reference(), Engine::Rootful).unwrap();
    lint_compose(&template, None, &envelope("studio"), Engine::Rootful).unwrap();
    lint_compose(&template, None, &Envelope::reference(), Engine::Rootless).unwrap();
    lint_set_toml(&real_set("set.toml"), &template).unwrap();
}

#[test]
fn on_a_mac_every_bind_source_lies_under_a_directory_the_omarchy_vm_mounts() {
    // #320: the VM mounts the work root, the secrets and the set directories, at their own
    // paths; the socket is the VM's own. The real set passes.
    let mac = envelope("mac");
    assert_eq!(
        mac.vm_mounts.as_deref().unwrap(),
        [
            PathBuf::from("/Users/Shared/omarchy-pool/work"),
            PathBuf::from("/Users/Shared/omarchy-pool/secrets"),
            PathBuf::from("/Users/Shared/omarchy-pool/set"),
        ]
    );
    let template = real_set("compose.yml");
    lint_compose(&template, None, &mac, Engine::Rootful).unwrap();
    for over in [
        "services:\n  dispatcher:\n    volumes: [\"${OMARCHY_WORK_ROOT}/cache:/cache\"]\n",
        "services:\n  dispatcher:\n    volumes: [\"./etc/extra.conf:/etc/extra.conf:ro\"]\n",
        "services:\n  dispatcher:\n    volumes: [\"/Users/Shared/omarchy-pool/set/files/x:/x:ro\"]\n",
    ] {
        lint_compose(&template, Some(over), &mac, Engine::Rootful)
            .unwrap_or_else(|v| panic!("{over}: {v:?}"));
    }
    // A path the envelope lists but the VM does not mount: the engine in the VM would bind
    // an empty directory of its own.
    let over =
        "services:\n  dispatcher:\n    volumes: [\"/Users/Shared/omarchy-pool/cache:/cache\"]\n";
    refused_for(
        lint_compose(&template, Some(over), &mac, Engine::Rootful),
        "vm_mount",
        over,
    );
    // The same set under a Linux envelope has no such rule.
    let linux = Envelope {
        vm_mounts: None,
        ..mac.clone()
    };
    lint_compose(&template, Some(over), &linux, Engine::Rootful).unwrap();
    // [vm] runtime colima without the three directories is refused; a shared VM's runtime
    // has no mounts the agent knows.
    let text = read("envelope/mac.toml");
    let e = Envelope::from_agent_toml(&mutate(
        &text,
        "work_root    = \"/Users/Shared/omarchy-pool/work\"\n",
        "",
    ))
    .unwrap_err();
    assert!(e.contains("[vm] runtime colima needs"), "{e}");
    let shared = Envelope::from_agent_toml(&mutate(
        &text,
        "runtime = \"colima\"",
        "runtime = \"docker-desktop\"",
    ))
    .unwrap();
    assert_eq!(shared.vm_mounts, None);
}

#[test]
fn the_real_host_set_is_refused_with_a_second_service_without_its_role_or_with_an_agent_key() {
    let template = real_set("compose.yml");
    let lint = |t: &str| lint_compose(t, None, &Envelope::reference(), Engine::Rootful);
    let second = format!(
        "{template}  helper:\n    image: ghcr.io/firemanxbr/omarchy-worker@RELEASE@\n    labels: {{ org.omarchy-pool.role: dispatcher }}\n"
    );
    refused_for(lint(&second), "services", "a second service");
    let no_role = mutate(
        &template,
        "    labels: { org.omarchy-pool.role: dispatcher }\n",
        "",
    );
    refused_for(lint(&no_role), "role", "no role label");
    let other_role = mutate(
        &template,
        "org.omarchy-pool.role: dispatcher",
        "org.omarchy-pool.role: pool",
    );
    refused_for(lint(&other_role), "role", "another role");
    for key in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GITHUB_TOKEN",
    ] {
        let keyed = mutate(
            &template,
            "${OMARCHY_TASK_SUBNETS:-10.231.0.0/16}",
            &format!("${{{key}}}"),
        );
        refused_for(lint(&keyed), "secret_interpolation", key);
    }
}

#[test]
fn the_real_set_toml_is_schema_3_with_the_dispatchers_ready_check_and_its_needs() {
    let set = parse_set_toml(&real_set("set.toml")).unwrap();
    assert_eq!(
        set,
        SetToml {
            schema: 3,
            project_default: "omarchy-host".into(),
            order: vec![],
            guard_s: 90,
            ready: BTreeMap::from([(
                "dispatcher".into(),
                Ready {
                    http: "127.0.0.1:8791/ready".into(),
                    wait_s: 120,
                }
            )]),
            needs: Needs {
                env_files: BTreeMap::from([(
                    "dispatcher".into(),
                    vec!["etc/dispatcher.env".into()]
                )]),
                host: BTreeMap::from([("emulated".into(), vec!["binfmt".into()])]),
            },
        }
    );
}

/// Refused, every violation under `set_toml` (one mistake may break two of its checks).
fn set_toml_refused(result: Result<(), Vec<Violation>>, case: &str) {
    let got = rules(result);
    assert!(
        !got.is_empty() && got.iter().all(|r| *r == "set_toml"),
        "{case}: {got:?}"
    );
}

#[test]
fn a_set_toml_that_breaks_schema_3_or_disagrees_with_the_template_is_refused() {
    let template = real_set("compose.yml");
    let good = real_set("set.toml");
    for (from, to) in [
        ("schema = 3", "schema = 2"),
        ("schema = 3", "schema = 4"),
        ("schema = 3", "schema = \"3\""),
        ("guard_s = 90", "guard_s = 90\nunknown = 1"),
        ("guard_s = 90", "guard_s = 0"),
        ("order   = []", "order   = [\"dispatcher\", \"dispatcher\"]"),
        ("order   = []", "order   = [\"pool-aarch64\"]"),
        (
            "project_default = \"omarchy-host\"",
            "project_default = \"Omarchy Host\"",
        ),
        ("[ready.\"dispatcher\"]", "[ready.\"helper\"]"),
        ("127.0.0.1:8791/ready", "0.0.0.0:8791/ready"),
        ("127.0.0.1:8791/ready", "192.168.1.10:8791/ready"),
        ("127.0.0.1:8791/ready", "127.0.0.1:0/ready"),
        ("wait_s = 120", "wait_s = 0"),
        ("wait_s = 120", "wait_s = 120\ntcp = \"127.0.0.1:8791\""),
        ("[\"etc/dispatcher.env\"]", "[]"),
        (
            "[\"etc/dispatcher.env\"]",
            "[\"etc/dispatcher.env\", \"etc/agent.env\"]",
        ),
        ("[\"etc/dispatcher.env\"]", "[\"../etc/dispatcher.env\"]"),
        ("{ dispatcher = [", "{ helper = ["),
        (
            "emulated = [\"binfmt\"]",
            "emulated = [\"binfmt\", \"modprobe\"]",
        ),
        ("emulated = [\"binfmt\"]", "native = [\"binfmt\"]"),
    ] {
        let bad = mutate(&good, from, to);
        set_toml_refused(lint_set_toml(&bad, &template), to);
    }
    // A template whose dispatcher names no env file needs none listed; one listed is refused.
    let no_env = mutate(&template, "    env_file: [etc/dispatcher.env]", "");
    set_toml_refused(
        lint_set_toml(&good, &no_env),
        "env file compose does not name",
    );
    // `./etc/dispatcher.env` is the same file.
    lint_set_toml(
        &mutate(
            &good,
            "[\"etc/dispatcher.env\"]",
            "[\"./etc/dispatcher.env\"]",
        ),
        &template,
    )
    .unwrap();
}
