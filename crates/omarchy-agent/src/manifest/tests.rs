use serde_json::{json, Value};

use super::{parse, Parsed};

const EXAMPLE: &str = include_str!("../../tests/fixtures/manifest/v2-example.json");

fn example() -> Value {
    serde_json::from_str(EXAMPLE).unwrap()
}

fn read(v: &Value) -> Result<Parsed, String> {
    parse(&serde_json::to_vec(v).unwrap()).map_err(|e| e.0)
}

fn current(v: &Value) -> super::Manifest {
    match read(v) {
        Ok(Parsed::Current(m)) => *m,
        other => panic!("expected a current manifest, got {other:?}"),
    }
}

fn refused(v: &Value) -> String {
    match read(v) {
        Err(e) => e,
        Ok(other) => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_design_example_reads_whole() {
    let m = current(&example());
    assert_eq!(m.outer().release().to_string(), "1.20.0");
    assert_eq!(
        m.outer().agent().asset("aarch64-linux").unwrap().name(),
        "omarchy-agent-aarch64-linux-musl"
    );
    assert_eq!(m.min_release().to_string(), "1.18.0");
    assert_eq!(m.pools(), ["https://omarchy-pool.example.org"]);
    assert_eq!(
        m.worker_image().index().repo(),
        "ghcr.io/firemanxbr/omarchy-worker"
    );
    assert_eq!(
        m.build_image("aarch64").unwrap().repo(),
        "docker.io/menci/archlinuxarm"
    );
    assert!(m
        .tool("aarch64-linux", "docker-compose")
        .unwrap()
        .url()
        .starts_with("https://"));
    assert_eq!(m.set_files("host").unwrap().len(), 2);
}

#[test]
fn valid_capacity_constants_round_trip_into_the_typed_value() {
    let v = example();
    let m = current(&v);
    let c = m.capacity().constants();
    assert_eq!(
        (
            c.min.cpus,
            c.min.mem_gb,
            c.min.work_disk_gb,
            c.min.engine_disk_gb
        ),
        (4, 8, 60, 40)
    );
    assert_eq!(
        (c.unit.cpus, c.unit.mem_gb, c.reserve.cpus, c.reserve.mem_gb),
        (1, 2, 1, 2)
    );
    assert_eq!(
        (
            c.units.build_per_size,
            c.units.job_reserved,
            c.max_size,
            c.community_max_size
        ),
        (2, 1, 4, 2)
    );
    assert!((c.sidecars.agent.cpus - 0.25).abs() < f64::EPSILON);
    assert!((c.emulated.share_when_native_waits - 0.5).abs() < f64::EPSILON);
    // Typed and back: the same JSON, field for field.
    assert_eq!(
        serde_json::to_value(m.capacity()).unwrap(),
        v["inner"]["capacity"]
    );
}

#[test]
fn an_extra_outer_field_and_an_unknown_inner_schema_need_a_newer_agent() {
    let mut v = example();
    v["mirrors"] = json!(["https://elsewhere.example"]);
    v["agent"]["riscv64-linux"] = json!({"sha256": "00", "asset": "x"});
    v["inner"] = json!({"schema": 4, "everything": "else", "is": ["new"]});
    match read(&v) {
        Ok(Parsed::NeedsNewerAgent { outer, why }) => {
            assert!(why.contains("inner.schema 4"), "{why}");
            assert_eq!(outer.agent().version().to_string(), "0.1.0");
        }
        other => panic!("expected needs a newer agent, got {other:?}"),
    }
}

#[test]
fn a_min_agent_above_this_agent_needs_a_newer_agent_whatever_inner_holds() {
    let mut v = example();
    v["min_agent"] = json!("99.0.0");
    v["inner"] = json!("not even an object");
    match read(&v) {
        Ok(Parsed::NeedsNewerAgent { why, .. }) => {
            assert!(why.contains("min_agent 99.0.0"), "{why}");
        }
        other => panic!("expected needs a newer agent, got {other:?}"),
    }
}

#[test]
fn an_extra_inner_field_is_refused() {
    let mut v = example();
    v["inner"]["pools_extra"] = json!([]);
    assert!(refused(&v).contains("unknown field `pools_extra`"));
    let mut v = example();
    v["inner"]["runtimes"] = json!({"podman": {}});
    assert!(refused(&v).contains("podman"));
}

#[test]
fn a_broken_outer_layer_is_refused() {
    for (field, value) in [
        ("release", json!("1.20.0")),
        ("min_agent", json!("0.1")),
        ("created", json!("yesterday")),
    ] {
        let mut v = example();
        v[field] = value;
        assert!(refused(&v).contains(field), "{field}");
    }
    let mut v = example();
    v.as_object_mut().unwrap().remove("agent");
    assert!(refused(&v).contains("agent"));
    let mut v = example();
    v["inner"]["schema"] = json!(2);
    assert!(refused(&v).contains("older"));
}

const CAPACITY_FIELDS: &[&str] = &[
    "min",
    "reserve",
    "unit",
    "units",
    "disk",
    "sidecars",
    "emulated",
    "max_size",
    "community_max_size",
    "min.cpus",
    "min.engine_disk_gb",
    "reserve.mem_gb",
    "unit.cpus",
    "units.build_per_size",
    "units.job_reserved",
    "disk.floor_gb",
    "sidecars.egress",
    "sidecars.agent.cpus",
    "emulated.share_when_native_waits",
];

fn at<'a>(v: &'a mut Value, dotted: &str) -> (&'a mut serde_json::Map<String, Value>, String) {
    let mut parts: Vec<&str> = dotted.split('.').collect();
    let last = parts.pop().unwrap().to_owned();
    let mut node = &mut v["inner"]["capacity"];
    for p in parts {
        node = &mut node[p];
    }
    (node.as_object_mut().unwrap(), last)
}

#[test]
fn a_capacity_block_with_a_missing_field_is_refused() {
    for field in CAPACITY_FIELDS {
        let mut v = example();
        let (obj, last) = at(&mut v, field);
        obj.remove(&last).unwrap();
        let e = refused(&v);
        assert!(
            e.contains(&format!("missing field `{last}`")),
            "{field}: {e}"
        );
    }
}

#[test]
fn a_capacity_block_with_an_unknown_field_is_refused() {
    for parent in [
        "",
        "min",
        "reserve",
        "unit",
        "units",
        "disk",
        "sidecars",
        "sidecars.egress",
        "emulated",
    ] {
        let mut v = example();
        let dotted = if parent.is_empty() {
            "surplus".to_owned()
        } else {
            format!("{parent}.surplus")
        };
        let (obj, last) = at(&mut v, &dotted);
        obj.insert(last, json!(1));
        let e = refused(&v);
        assert!(e.contains("unknown field `surplus`"), "{parent}: {e}");
    }
}

#[test]
fn capacity_constants_that_would_unbound_parallelism_are_refused() {
    for (field, value) in [
        ("unit.cpus", json!(0)),
        ("unit.mem_gb", json!(0)),
        ("units.build_per_size", json!(0)),
        ("units.audit", json!(0)),
        ("max_size", json!(0)),
        ("community_max_size", json!(5)),
        ("sidecars.agent.cpus", json!(1.0)),
        ("sidecars.egress.mem_mb", json!(4096)),
        ("emulated.share_when_native_waits", json!(1.5)),
        ("min.cpus", json!(1_000_000)),
        ("unit.cpus", json!(-1)),
        ("unit.cpus", json!(1.5)),
    ] {
        let mut v = example();
        let (obj, last) = at(&mut v, field);
        obj.insert(last, value.clone());
        let e = refused(&v);
        assert!(
            e.contains("capacity") || e.contains("invalid"),
            "{field} = {value}: {e}"
        );
    }
}

#[test]
fn pins_that_are_not_digests_are_refused() {
    for (path, value) in [
        (
            &["images", "build", "x86_64"][..],
            json!("docker.io/library/archlinux:base-devel"),
        ),
        (&["images", "worker", "index"][..], json!("sha256:ABC")),
        (
            &["images", "worker", "repo"][..],
            json!("ghcr.io/x/y:latest"),
        ),
        (&["pools"][..], json!(["http://pool.example"])),
        (
            &["tools", "x86_64-linux", "docker", "url"][..],
            json!("http://x.example/docker"),
        ),
        (
            &["sets", "host", "files"][..],
            json!({"../escape": format!("sha256:{}", "0".repeat(64))}),
        ),
    ] {
        let mut v = example();
        let mut node = &mut v["inner"];
        for p in path {
            node = &mut node[*p];
        }
        *node = value;
        refused(&v);
    }
}
