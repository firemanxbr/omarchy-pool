use std::path::{Path, PathBuf};

use super::{lint_compose, references, Engine, Envelope, Reference, Violation};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lint")
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(fixtures().join(rel)).unwrap()
}

fn envelope(name: &str) -> Envelope {
    Envelope::from_agent_toml(&read(&format!("envelope/{name}.toml"))).unwrap()
}

/// `<dir>/compose.yml` with `over` merged onto it, as `lint-set <dir> --override` reads them.
fn lint_set(
    dir: &Path,
    over: Option<&Path>,
    envelope: &Envelope,
    engine: Engine,
) -> Result<(), Vec<Violation>> {
    let read = |p: &Path| std::fs::read_to_string(p).unwrap();
    let over = over.map(read);
    lint_compose(
        &read(&dir.join("compose.yml")),
        over.as_deref(),
        envelope,
        engine,
    )
}

const HOST: &str = include_str!("../../tests/fixtures/lint/host/compose.yml");

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
