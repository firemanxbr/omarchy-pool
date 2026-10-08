use std::path::{Path, PathBuf};

use std::cell::RefCell;

use super::emulation::{self, Binfmt, Emulated, Held, Lanes, Smoke};
use super::probe::{self, CgroupLimits, Engine, Facts};
use super::sandbox;
use super::{preflight, write_if_changed, AgentToml, Capacity, Caps, Isolation, Limits, Written};
use crate::manifest::{self, Parsed};

const GB: u64 = 1 << 30;

/// The signed constants of the design's example manifest (unit 1 CPU / 2 GB, reserve
/// 1 CPU / 2 GB, minimum 4 CPUs, 8 GB, 60 GB work, 40 GB engine, one job unit reserved).
fn constants() -> manifest::Capacity {
    let bytes = include_bytes!("../../tests/fixtures/manifest/v2-example.json");
    match manifest::parse(bytes) {
        Ok(Parsed::Current(m)) => m.capacity().clone(),
        other => panic!("the example manifest must read whole: {other:?}"),
    }
}

const ALL_LIMITS: Limits = Limits {
    cpus_hard: true,
    memory_hard: true,
    pids: true,
    cgroup_v2: true,
};

fn engine(cpus: u32, mem_bytes: u64) -> Engine {
    Engine {
        cpus,
        mem_bytes,
        root_dir: "/var/lib/docker".into(),
        arch: "aarch64".into(),
        rootless: false,
        userns: false,
        cgroup_v2: true,
        cpus_hard: true,
        memory_hard: true,
        pids: true,
        kernel: "6.8.0-1017-azure".into(),
        runtimes: Vec::new(),
    }
}

/// A host as the engine reports it: `MemTotal` is what the kernel manages, a little under
/// the nominal size (as real hosts read it: an "8 GB" VM about 7.75 GiB).
fn host(cpus: u32, nominal_gb: u64) -> Facts {
    let mem_total = match nominal_gb {
        6 => 6_241_120_256,
        8 => 8_321_499_136,
        16 => 16_696_745_984,
        32 => 33_443_418_112,
        64 => 67_215_022_080,
        _ => unreachable!(),
    };
    Facts::for_test(
        engine(cpus, mem_total),
        CgroupLimits::default(),
        (400, 200),
        ALL_LIMITS,
    )
}

fn units(f: &Facts, caps: &Caps) -> u32 {
    Capacity::new(f, caps, &constants()).units()
}

#[test]
fn the_four_example_hosts_of_the_design_get_their_units() {
    let caps = Caps::default();
    // design v2 §7.3: minimum, a small VPS, the Studio, a large box; the memory as the
    // engine's MemTotal reads, to the nearest GB.
    for (cpus, gb, read_gb, want) in [
        (4, 8, 8, 3),
        (8, 16, 16, 7),
        (12, 32, 31, 11),
        (16, 64, 63, 15),
    ] {
        let c = Capacity::new(&host(cpus, gb), &caps, &constants());
        assert_eq!(c.units(), want, "{cpus} cores, {gb} GB");
        assert_eq!((c.cpus(), c.mem_gb()), (cpus, read_gb));
        assert_eq!(c.job_reserved(), 1);
        assert!(!c.below_minimum());
        assert!(preflight(&c).is_empty(), "{:?}", preflight(&c));
    }
}

#[test]
fn the_owner_caps_only_lower_what_detection_found() {
    let studio = host(12, 32);
    let cap = |max_units, max_cpus, max_mem_gb| Caps {
        max_units,
        max_cpus,
        max_mem_gb,
        ..Caps::default()
    };
    assert_eq!(units(&studio, &cap(Some(5), None, None)), 5);
    assert_eq!(units(&studio, &cap(None, Some(6), None)), 5);
    assert_eq!(units(&studio, &cap(None, None, Some(12))), 5);
    // Caps above what was found change nothing.
    assert_eq!(units(&studio, &cap(Some(40), Some(64), Some(256))), 11);
    // A cap below the minimum: the host does not join.
    let c = Capacity::new(&studio, &cap(None, Some(3), None), &constants());
    assert!(c.below_minimum());
    assert_eq!(c.units(), 0);
    assert_eq!(
        preflight(&c),
        ["below the minimum to join: CPUs: 3 (the minimum is 4)"]
    );
    // No unit left after the caps is a blocker of its own.
    let c = Capacity::new(&studio, &cap(Some(0), None, None), &constants());
    assert_eq!(
        preflight(&c),
        ["no unit is left after the reserve and the owner's caps"]
    );
}

#[test]
fn a_host_below_the_minimum_is_refused_with_the_numbers_and_later_claims_nothing() {
    let caps = Caps::default();
    let c = Capacity::new(&host(2, 8), &caps, &constants());
    assert_eq!(
        preflight(&c),
        ["below the minimum to join: CPUs: 2 (the minimum is 4)"]
    );
    let c = Capacity::new(&host(4, 6), &caps, &constants());
    assert_eq!(
        preflight(&c),
        ["below the minimum to join: memory (GB): 6 (the minimum is 8)"]
    );

    // A joined host whose disk fills up later: it keeps running, claims nothing, and says
    // so in the file the dispatcher and the pool read.
    let full = Facts::for_test(
        engine(12, 32 * GB),
        CgroupLimits::default(),
        (59, 39),
        ALL_LIMITS,
    );
    let c = Capacity::new(&full, &caps, &constants());
    assert!(c.below_minimum());
    let f = c.file("2026-10-01T00:00:00Z");
    assert!(f.below_minimum);
    assert_eq!((f.units, f.job_reserved), (0, 0));
    assert_eq!(
        preflight(&c),
        [
            "below the minimum to join: free disk on the work root (GB): 59 (the minimum is 60)",
            "below the minimum to join: free disk on the engine's data root (GB): 39 (the minimum is 40)",
        ]
    );
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "omarchy-agent-capacity-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn put(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

#[test]
fn a_systemd_slice_with_cpu_quota_or_memory_max_lowers_the_totals() {
    let root = tmp("cgroup");
    let me = "user.slice/user-1000.slice/user@1000.service/app.slice/omarchy-agent.service";
    // CPUQuota=200% on the user's slice, MemoryMax=3G on the user manager, unlimited
    // where the agent itself sits.
    put(
        &root,
        "user.slice/user-1000.slice/cpu.max",
        "200000 100000\n",
    );
    put(&root, "user.slice/user-1000.slice/memory.max", "max\n");
    put(
        &root,
        "user.slice/user-1000.slice/user@1000.service/memory.max",
        "3221225472\n",
    );
    put(&root, &format!("{me}/cpu.max"), "max 100000\n");
    put(&root, &format!("{me}/memory.max"), "max\n");
    let cg = probe::cgroup_limits(&root, &format!("0::/{me}\n"));
    assert_eq!(cg.cpus, Some(2));
    assert_eq!(cg.mem_bytes, Some(3 * GB));

    let f = Facts::for_test(engine(12, 32 * GB), cg, (400, 200), ALL_LIMITS);
    assert_eq!(f.totals(), (2, 3));
    let c = Capacity::new(&f, &Caps::default(), &constants());
    assert!(c.below_minimum());
    assert_eq!(c.units(), 0);

    // A VPS slice that still meets the minimum: units follow the slice, not the engine.
    put(
        &root,
        "user.slice/user-1000.slice/cpu.max",
        "550000 100000\n",
    );
    put(
        &root,
        "user.slice/user-1000.slice/user@1000.service/memory.max",
        &(12 * GB).to_string(),
    );
    let cg = probe::cgroup_limits(&root, &format!("0::/{me}\n"));
    let f = Facts::for_test(engine(12, 32 * GB), cg, (400, 200), ALL_LIMITS);
    assert_eq!(f.totals(), (5, 12));
    assert_eq!(units(&f, &Caps::default()), 4);

    // Unlimited everywhere, a cgroup v1 host, and a path that leaves the root: no limit.
    assert_eq!(
        probe::cgroup_limits(&root, "0::/\n"),
        CgroupLimits::default()
    );
    assert_eq!(
        probe::cgroup_limits(&root, "4:memory:/user.slice\n"),
        CgroupLimits::default()
    );
    assert_eq!(
        probe::cgroup_limits(&root, "0::/../etc\n"),
        CgroupLimits::default()
    );
    let _ = std::fs::remove_dir_all(&root);
}

const ROOTFUL: &str = r#"{"ID":"x","NCPU":12,"MemTotal":33443418112,"DockerRootDir":"/var/lib/docker",
 "Architecture":"aarch64","OSType":"linux","CgroupDriver":"systemd","CgroupVersion":"2",
 "MemoryLimit":true,"SwapLimit":true,"CpuCfsPeriod":true,"CpuCfsQuota":true,"CPUShares":true,
 "CPUSet":true,"PidsLimit":true,
 "SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"],
 "ClientInfo":{"Version":"28.5.1"}}"#;

const ROOTLESS_DOCKER: &str = r#"{"NCPU":8,"MemTotal":16696745984,
 "DockerRootDir":"/home/omarchy/.local/share/docker","Architecture":"x86_64",
 "CgroupDriver":"systemd","CgroupVersion":"2","MemoryLimit":true,"CpuCfsQuota":true,
 "PidsLimit":true,
 "SecurityOptions":["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]}"#;

/// Rootless docker on a host whose user manager delegates no controllers (cgroup v1, or
/// v2 without `Delegate=`): `docker info` says the limits are off.
const ROOTLESS_NO_DELEGATION: &str = r#"{"NCPU":8,"MemTotal":16471932928,
 "DockerRootDir":"/home/omarchy/.local/share/docker","Architecture":"x86_64",
 "CgroupDriver":"none","CgroupVersion":"1","MemoryLimit":false,"CpuCfsQuota":false,
 "PidsLimit":false,"SecurityOptions":["name=seccomp,profile=builtin","name=rootless"]}"#;

/// Podman's Docker-compatible API names Go's architectures.
const ROOTLESS_PODMAN: &str = r#"{"NCPU":4,"MemTotal":8215928832,
 "DockerRootDir":"/home/omarchy/.local/share/containers/storage","Architecture":"arm64",
 "CgroupVersion":"2","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true,
 "SecurityOptions":["name=seccomp,profile=/usr/share/containers/seccomp.json","name=rootless"]}"#;

const USERNS: &str = r#"{"NCPU":12,"MemTotal":33443418112,"DockerRootDir":"/var/lib/docker/100000.100000",
 "Architecture":"aarch64","CgroupVersion":"2","MemoryLimit":true,"CpuCfsQuota":true,
 "PidsLimit":true,"SecurityOptions":["name=seccomp,profile=builtin","name=userns"]}"#;

fn facts(info: &str) -> Facts {
    let e = probe::parse_info(info).unwrap();
    let limits = Limits {
        cpus_hard: e.cpus_hard,
        memory_hard: e.memory_hard,
        pids: e.pids,
        cgroup_v2: e.cgroup_v2,
    };
    Facts::for_test(e, CgroupLimits::default(), (410, 223), limits)
}

#[test]
fn docker_info_reads_on_rootful_and_rootless_docker_and_podman() {
    let c = Capacity::new(&facts(ROOTFUL), &Caps::default(), &constants());
    assert_eq!((c.cpus(), c.mem_gb(), c.units()), (12, 31, 11));
    assert_eq!(c.isolation(), Isolation::Root);

    let c = Capacity::new(&facts(ROOTLESS_DOCKER), &Caps::default(), &constants());
    assert_eq!((c.cpus(), c.mem_gb(), c.units()), (8, 16, 7));
    assert_eq!(c.isolation(), Isolation::User);
    assert!(preflight(&c).is_empty());

    let c = Capacity::new(&facts(ROOTLESS_PODMAN), &Caps::default(), &constants());
    assert_eq!((c.cpus(), c.mem_gb(), c.units()), (4, 8, 3));
    assert_eq!(c.isolation(), Isolation::User);
    assert_eq!(c.file("t").lanes[0].arch, "aarch64");

    let c = Capacity::new(&facts(USERNS), &Caps::default(), &constants());
    assert_eq!(c.isolation(), Isolation::Subuid);

    // Both free-disk values, whatever the runtime, rounded down to 10 GB in the file.
    for info in [ROOTFUL, ROOTLESS_DOCKER, ROOTLESS_PODMAN] {
        let c = Capacity::new(&facts(info), &Caps::default(), &constants());
        assert_eq!((c.disk_free_gb().work, c.disk_free_gb().engine), (410, 223));
        let json = serde_json::to_value(c.file("t")).unwrap();
        assert_eq!(
            json["disk_free_gb"],
            serde_json::json!({"work": 410, "engine": 220})
        );
    }

    for bad in [
        r#"{"ServerErrors":["Cannot connect to the Docker daemon"]}"#,
        r#"{"NCPU":4,"MemTotal":8215928832,"Architecture":"riscv64"}"#,
        "not json",
    ] {
        assert!(probe::parse_info(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_rootless_runtime_without_cgroup_v2_delegation_is_a_preflight_blocker() {
    let c = Capacity::new(
        &facts(ROOTLESS_NO_DELEGATION),
        &Caps::default(),
        &constants(),
    );
    assert_eq!(c.isolation(), Isolation::User);
    let blockers = preflight(&c);
    assert_eq!(blockers.len(), 1, "{blockers:?}");
    assert!(
        blockers[0].starts_with("limits cannot be enforced: a rootless runtime needs cgroup v2"),
        "{blockers:?}"
    );

    // cgroup v2 present, but the probe container shows the memory limit did not land.
    let mut f = facts(ROOTLESS_DOCKER);
    f.limits.memory_hard = false;
    let c = Capacity::new(&f, &Caps::default(), &constants());
    assert_eq!(
        preflight(&c),
        [
            "limits cannot be enforced: this runtime ignores --memory (a rootless runtime \
          needs systemd to delegate cpu, memory and pids to the user)"
        ]
    );
}

#[test]
fn the_probe_container_output_reads_into_limits_and_free_disk() {
    let ok = "cpu.max=50000 100000\nmemory.max=67108864\npids.max=32\n\
              overlay 482344960 123456 220000000 1% /\n";
    assert_eq!(
        probe::probe_limits(ok),
        (Some(true), Some(true), Some(true))
    );
    assert_eq!(probe::df_free(ok), Some(220_000_000 * 1024));
    let ignored = "cpu.max=max 100000\nmemory.max=max\npids.max=max\nfs 1 1 5 1% /\n";
    assert_eq!(
        probe::probe_limits(ignored),
        (Some(false), Some(false), Some(false))
    );
    let v1 = "cpu.max=\nmemory.max=\npids.max=\nfs 1 1 5 1% /\n";
    assert_eq!(probe::probe_limits(v1), (None, None, None));
    // The engine kernel's page size, when the image has `getconf`.
    assert_eq!(
        probe::probe_page_size("pagesize=16384\nfs 1 1 5 1% /\n"),
        Some(16384)
    );
    assert_eq!(probe::probe_page_size("pagesize=\nfs 1 1 5 1% /\n"), None);
    assert_eq!(probe::probe_page_size(ok), None);
    assert_eq!(probe::df_free("garbage"), None);

    assert_eq!(
        probe::mem_available("MemTotal: 32000000 kB\nMemAvailable:   20971520 kB\n"),
        Some(20 * GB)
    );
}

/// A docker CLI that answers `info` and the probe container, and fails the next
/// `limited-fails` runs that carry the limits.
fn fake_docker(dir: &Path, limited_fails: u32) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    put(dir, "info.json", ROOTFUL);
    put(dir, "limited-fails", &limited_fails.to_string());
    let d = dir.display();
    let docker = dir.join("docker");
    put(
        dir,
        "docker",
        &format!(
            r#"#!/bin/sh
case "$1" in
info) cat '{d}/info.json' ;;
run)
  case " $* " in *" --cpus "*)
    n=$(cat '{d}/limited-fails')
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > '{d}/limited-fails'; echo refused >&2; exit 125; fi ;;
  esac
  printf 'cpu.max=50000 100000\nmemory.max=67108864\npids.max=32\npagesize=4096\n'
  printf 'overlay 1 1 52428800 1%% /\n' ;;
*) exit 2 ;;
esac
"#
        ),
    );
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
    docker
}

#[test]
fn a_limited_probe_run_that_fails_once_is_retried_before_the_limits_read_as_refused() {
    let detect = |name: &str, limited_fails: u32| {
        let dir = tmp(name);
        let docker = fake_docker(&dir, limited_fails);
        let p = probe::Probe {
            docker: docker.to_str().unwrap(),
            host: None,
            work_root: &dir,
            image: Some("build-image"),
            emulation: None,
            sandbox: None,
        };
        let out = probe::detect(&p);
        let _ = std::fs::remove_dir_all(&dir);
        out
    };
    // A transient failure (a pull, the registry): the retry after the unlimited run
    // shows the limits landing.
    let f = detect("probe-blip", 1).unwrap();
    assert_eq!(f.limits(), ALL_LIMITS);
    // The engine's kernel and data root, as the probe container measured them, not this
    // process's page size or a local directory named DockerRootDir.
    assert_eq!((f.page_kb(), f.disk_free_gb().engine), (4, 50));
    // Refused again after the unlimited run answered: the runtime refuses the limits.
    let f = detect("probe-refused", 2).unwrap();
    assert_eq!(
        (
            f.limits().cpus_hard,
            f.limits().memory_hard,
            f.limits().pids
        ),
        (false, false, false)
    );
    // Clean on the first try: one run.
    assert_eq!(detect("probe-clean", 0).unwrap().limits(), ALL_LIMITS);
}

#[test]
fn a_linked_run_directory_or_capacity_json_is_refused() {
    let dir = tmp("links");
    let elsewhere = tmp("links-elsewhere");
    let c = Capacity::new(&facts(ROOTFUL), &Caps::default(), &constants());
    std::os::unix::fs::symlink(&elsewhere, dir.join("run")).unwrap();
    assert!(write_if_changed(&dir, &c, "2026-10-01T00:00:00Z").is_err());
    std::fs::remove_file(dir.join("run")).unwrap();
    std::fs::create_dir(dir.join("run")).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("x.json"), dir.join("run/capacity.json")).unwrap();
    assert!(write_if_changed(&dir, &c, "2026-10-01T00:00:00Z").is_err());
    assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&elsewhere);
}

#[test]
fn capacity_json_is_rewritten_only_when_something_changed() {
    let dir = tmp("write");
    let caps = Caps {
        dedicated: true,
        ..Caps::default()
    };
    let studio = Capacity::new(&facts(ROOTFUL), &caps, &constants());
    let path = dir.join("run/capacity.json");

    assert_eq!(
        write_if_changed(&dir, &studio, "2026-10-01T00:00:00Z").unwrap(),
        Written::Changed
    );
    let first = std::fs::read_to_string(&path).unwrap();
    let v: serde_json::Value = serde_json::from_str(&first).unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "schema": 2, "at": "2026-10-01T00:00:00Z", "cpus": 12, "mem_gb": 31, "page_kb": 4,
            "disk_free_gb": {"work": 410, "engine": 220},
            "units": 11, "job_reserved": 1, "agent_slots": 2,
            "lanes": [{"arch": "aarch64", "mode": "native"}],
            "held_lanes": [],
            "isolation": "root", "dedicated": true,
            "limits": {"cpus_hard": true, "memory_hard": true, "pids": true},
            "below_minimum": false,
            "sandbox": null
        })
    );

    // An hour later, the same host: nothing is written, no rollout round.
    assert_eq!(
        write_if_changed(&dir, &studio, "2026-10-01T01:00:00Z").unwrap(),
        Written::Unchanged
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), first);

    // The owner lowers the cap: the file changes, and that starts a round.
    let capped = Capacity::new(
        &facts(ROOTFUL),
        &Caps {
            max_units: Some(5),
            ..caps.clone()
        },
        &constants(),
    );
    assert_eq!(
        write_if_changed(&dir, &capped, "2026-10-01T02:00:00Z").unwrap(),
        Written::Changed
    );
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        (v["units"].as_u64(), v["at"].as_str()),
        (Some(5), Some("2026-10-01T02:00:00Z"))
    );

    // A file the run loop narrowed to the pool's settings (#325): the same detection
    // leaves the narrowing in place; another one goes in whole (the loop narrows it again).
    let mut narrowed = v.clone();
    narrowed["detected"] = serde_json::json!({"units": 5, "job_reserved": 1, "lanes": v["lanes"]});
    narrowed["settings"] = serde_json::json!({"units": 2, "emulate": null});
    narrowed["units"] = 2.into();
    std::fs::write(&path, narrowed.to_string()).unwrap();
    assert_eq!(
        write_if_changed(&dir, &capped, "2026-10-01T02:30:00Z").unwrap(),
        Written::Unchanged
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&path).unwrap())
            .unwrap()["units"],
        2
    );
    assert_eq!(
        write_if_changed(&dir, &studio, "2026-10-01T02:45:00Z").unwrap(),
        Written::Changed
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&path).unwrap())
            .unwrap()["units"],
        11
    );

    // A file someone else wrote, or garbage, is replaced.
    std::fs::write(&path, "{}").unwrap();
    assert_eq!(
        write_if_changed(&dir, &capped, "2026-10-01T03:00:00Z").unwrap(),
        Written::Changed
    );
    // Nothing is left beside it.
    let names: Vec<_> = std::fs::read_dir(dir.join("run"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["capacity.json"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn agent_toml_gives_the_caps_and_where_things_are() {
    let a = AgentToml::parse(
        r#"
pool = "https://pool.example"
[set]
dir = "/home/omarchy/.local/share/omarchy-agent/sets/host"
work_root = "/srv/omarchy-pool/host"
socket_cli = "/var/run/docker.sock"
[envelope]
max_units = 11
max_cpus = 12
max_mem_gb = 32
emulate = ["x86_64"]
agent_slots = 1
dedicated = true
"#,
    )
    .unwrap();
    assert_eq!(
        a.caps,
        Caps {
            max_units: Some(11),
            max_cpus: Some(12),
            max_mem_gb: Some(32),
            agent_slots: 1,
            dedicated: true,
            emulate: Some(vec!["x86_64".into()]),
            sandbox: sandbox::Setting::Auto,
        }
    );
    assert_eq!(a.work_root.as_deref(), Some("/srv/omarchy-pool/host"));
    // `emulate = []` keeps every emulated lane off; absent, detection decides; an
    // architecture the pool does not build is refused, not ignored.
    assert_eq!(
        AgentToml::parse("[envelope]\nemulate = []\n")
            .unwrap()
            .caps
            .emulate,
        Some(vec![])
    );
    assert_eq!(AgentToml::parse("[envelope]\n").unwrap().caps.emulate, None);
    assert!(AgentToml::parse("[envelope]\nemulate = [\"riscv64\"]\n").is_err());
    assert!(AgentToml::parse("[envelope]\nemulate = \"x86_64\"\n").is_err());
    assert_eq!(AgentToml::parse("").unwrap().caps, Caps::default());
    assert!(AgentToml::parse("[envelope]\nmax_units = -1\n").is_err());
    assert!(AgentToml::parse("[envelope]\nmax_units = \"all\"\n").is_err());
    // A misspelt cap is refused, not silently dropped; every key of §12 reads.
    assert!(AgentToml::parse("[envelope]\nmax_unit = 5\n").is_err());
    assert!(AgentToml::parse(
        "[envelope]\nallow_socket = true\nrootful_ack = true\nuserns_remap = false\n\
         paths = []\ndrivers = [\"compose\"]\ncache_caps = { build_gb = 120 }\n\
         agent_budget = { calls_per_task = 200 }\ntask_subnets = \"10.232.0.0/16\"\n\
         diagnostics = false\nsoak_minutes = 0\nsandbox = \"auto\"\n"
    )
    .is_ok());
    // The sandbox (#330): auto, off or a runtime's name; anything else refused, not ignored.
    let sb = |t: &str| AgentToml::parse(t).map(|a| a.caps.sandbox);
    assert_eq!(sb(""), Ok(sandbox::Setting::Auto));
    assert_eq!(
        sb("[envelope]\nsandbox = \"off\"\n"),
        Ok(sandbox::Setting::Off)
    );
    assert_eq!(
        sb("[envelope]\nsandbox = \"kata-qemu\"\n"),
        Ok(sandbox::Setting::Named("kata-qemu".into()))
    );
    for bad in [
        "sandbox = true",
        "sandbox = \"--privileged\"",
        "sandbox = \"Runsc\"",
    ] {
        assert!(sb(&format!("[envelope]\n{bad}\n")).is_err(), "{bad}");
    }
    // The work root is a plain absolute path, as lint-set reads it.
    assert!(AgentToml::parse("[set]\nwork_root = \"srv/pool\"\n").is_err());
    assert!(AgentToml::parse("[set]\nwork_root = \"/srv/../etc\"\n").is_err());
}

#[test]
fn a_macs_vm_gives_its_level_its_own_memory_and_the_rosetta_lane_the_envelope_allows() {
    // One way for install, `capacity --write` and the run loop's count (#320).
    use super::probe::{in_mac_vm, LaneSaid, MacVm};
    use super::VmKind;
    static NONE: [String; 0] = [];
    let meminfo = "MemTotal: 32000000 kB\nMemAvailable: 30000000 kB\n";
    let vm = |emulate: Option<&'static [String]>, rosetta: bool| MacVm {
        kind: VmKind::Dedicated,
        meminfo: Some(meminfo),
        rosetta,
        emulate,
        x86_64_image: Some("ghcr.io/o/build@sha256:00"),
    };
    let mut smokes = Vec::new();
    let mut smoke = |img: &str| {
        smokes.push(img.to_owned());
        Ok(())
    };
    let (f, said) = in_mac_vm(host(8, 32), &vm(None, true), &mut smoke);
    assert_eq!(said, None);
    assert_eq!(f.isolation(), Isolation::Vm);
    assert_eq!(f.mem_available, Some(30_000_000 * 1024));
    let c = Capacity::new(&f, &Caps::default(), &constants());
    let lanes = serde_json::to_value(c.file("t").lanes).unwrap();
    assert_eq!(
        lanes,
        serde_json::json!([{"arch": "aarch64", "mode": "native"}, {"arch": "x86_64", "mode": "emulated", "via": "rosetta", "page16k": false}])
    );
    // One lanes model with #338's: the Rosetta lane is detection's kind, on the VM's 4K pages,
    // and a Mac holds none in `held_lanes` (its reasons go to the screen and the journal).
    assert!(c.held_lanes().is_empty());
    // `emulate = []` leaves the lane off, whatever the VM runs: no count widens it.
    let (f, said) = in_mac_vm(host(8, 32), &vm(Some(&NONE), true), &mut smoke);
    assert_eq!(f.emulation(), None);
    assert_eq!(
        said,
        Some(LaneSaid::Note(
            "the x86_64 lane is off: the envelope's emulate leaves it out".into()
        ))
    );
    assert_eq!(smokes.len(), 1, "no smoke run for a lane left out");
    // A smoke run that fails: no lane, a warning.
    let (f, said) = in_mac_vm(host(8, 32), &vm(None, true), &mut |_| Err("exit 1".into()));
    assert_eq!(f.emulation(), None);
    assert!(matches!(said, Some(LaneSaid::Warning(w)) if w.contains("exit 1")));
    // Docker Desktop's VM: its level only; its memory and lanes are not the agent's.
    let shared = MacVm {
        kind: VmKind::Shared,
        ..vm(None, true)
    };
    let (f, said) = in_mac_vm(host(8, 32), &shared, &mut |_| panic!("no smoke run"));
    assert_eq!(
        (f.isolation(), said, f.mem_available),
        (Isolation::VmShared, None, None)
    );
}

#[test]
fn at_is_an_rfc3339_utc_time() {
    assert_eq!(super::utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(super::utc(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(super::utc(1_790_812_799), "2026-09-30T23:59:59Z");
    assert!(crate::manifest::is_timestamp(&super::now()));
}

// ---------- emulated lanes (#338, design v2 §7.5; D33) ----------

/// The `x86_64` build image of a release, by digest.
const X86_IMAGE: &str =
    "docker.io/library/archlinux@sha256:b944cc65c5f28665dfd5fdbf5ed2997c88f5bb4a0aefac7ee8a7ef01893e5ed9";
/// Its `aarch64` build image.
const ARM_IMAGE: &str =
    "docker.io/menci/archlinuxarm@sha256:15fa2527d481a6b8ddce7d49c535bfd3a2a63a6d7d840ace551fd21c1827c08b";

/// A release's build images, by architecture.
fn release() -> Vec<(&'static str, String)> {
    vec![
        ("aarch64", ARM_IMAGE.to_owned()),
        ("x86_64", X86_IMAGE.to_owned()),
    ]
}

/// A smoke run that passes or fails, its loader check too (#VM4K), and remembers what each
/// was asked.
struct FakeSmoke {
    fails: Option<&'static str>,
    loader_fails: Option<&'static str>,
    asked: RefCell<Vec<(String, String)>>,
    loaded: RefCell<Vec<(String, String)>>,
}

impl FakeSmoke {
    fn passing() -> Self {
        FakeSmoke {
            fails: None,
            loader_fails: None,
            asked: RefCell::new(Vec::new()),
            loaded: RefCell::new(Vec::new()),
        }
    }
    fn failing(why: &'static str) -> Self {
        FakeSmoke {
            fails: Some(why),
            ..FakeSmoke::passing()
        }
    }
    /// `true` and `pacman --version` pass, `sudo -V` does not.
    fn loader_failing(why: &'static str) -> Self {
        FakeSmoke {
            loader_fails: Some(why),
            ..FakeSmoke::passing()
        }
    }
    fn asked(&self) -> Vec<(String, String)> {
        self.asked.borrow().clone()
    }
    fn loaded(&self) -> Vec<(String, String)> {
        self.loaded.borrow().clone()
    }
}

impl Smoke for FakeSmoke {
    fn emulation(&self, arch: &str, image: &str) -> Result<(), String> {
        self.asked.borrow_mut().push((arch.into(), image.into()));
        self.fails.map_or(Ok(()), |w| Err(w.into()))
    }
    fn loader(&self, arch: &str, image: &str) -> Result<(), String> {
        self.loaded.borrow_mut().push((arch.into(), image.into()));
        self.loader_fails.map_or(Ok(()), |w| Err(w.into()))
    }
}

/// A binfmt table as the kernel shows it, with one handler file per entry.
fn binfmt_tree(name: &str, handlers: &[(&str, &str)]) -> PathBuf {
    let d = tmp(name);
    for (h, text) in handlers {
        put(&d, h, text);
    }
    d
}

const QEMU_X86_F: &str = "enabled\ninterpreter /usr/bin/qemu-x86_64-static\nflags: POCF\noffset 0\nmagic 7f454c4602010100\n";

fn studio(binfmt: &Path, emulate: Option<&[String]>, page_kb: u32, smoke: &FakeSmoke) -> Lanes {
    emulation::detect(
        "aarch64",
        page_kb,
        &emulation::Probe {
            binfmt,
            images: &release(),
            emulate,
        },
        smoke,
    )
}

#[test]
fn an_aarch64_host_with_binfmt_reports_its_x86_64_lane_after_the_smoke_run() {
    let d = binfmt_tree("emu-on", &[("qemu-x86_64", QEMU_X86_F)]);
    let smoke = FakeSmoke::passing();
    let lanes = studio(&d, None, 4, &smoke);
    assert_eq!(
        smoke.asked(),
        [("x86_64".to_owned(), X86_IMAGE.to_owned())],
        "the smoke run is the release's x86_64 build image, by digest"
    );
    assert_eq!(
        smoke.loaded(),
        [("x86_64".to_owned(), X86_IMAGE.to_owned())],
        "on 4K pages the loader check runs too, in the same image (#VM4K)"
    );
    assert_eq!(
        lanes,
        Lanes {
            on: vec![Emulated {
                arch: "x86_64".into(),
                via: "qemu",
                page16k: false
            }],
            held: vec![]
        }
    );
    // In capacity.json, the claim's and the host report's: the native lane first.
    let f = facts(ROOTFUL).with_emulation(4, lanes);
    let c = Capacity::new(&f, &Caps::default(), &constants());
    let v = serde_json::to_value(c.file("t")).unwrap();
    assert_eq!(
        v["lanes"],
        serde_json::json!([
            {"arch": "aarch64", "mode": "native"},
            {"arch": "x86_64", "mode": "emulated", "via": "qemu", "page16k": false}
        ])
    );
    assert_eq!(v["held_lanes"], serde_json::json!([]));
    // An emulated lane shares the host's units: it adds none.
    assert_eq!(c.units(), 11);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn without_binfmt_the_lane_is_held_for_a_person_and_the_native_lane_stays() {
    for (name, handlers, detail) in [
        ("emu-missing", &[][..], "no qemu-x86_64 handler"),
        (
            "emu-disabled",
            &[(
                "qemu-x86_64",
                "disabled\ninterpreter /usr/bin/qemu-x86_64\nflags: POCF\n",
            )][..],
            "qemu-x86_64 is disabled",
        ),
        (
            "emu-no-f",
            &[(
                "qemu-x86_64",
                "enabled\ninterpreter /usr/bin/qemu-x86_64\nflags: OC\n",
            )][..],
            "without the F flag",
        ),
    ] {
        let d = binfmt_tree(name, handlers);
        let smoke = FakeSmoke::passing();
        let lanes = studio(&d, None, 16, &smoke);
        assert!(
            smoke.asked().is_empty(),
            "{name}: no smoke run without binfmt"
        );
        assert!(lanes.on.is_empty(), "{name}");
        assert_eq!(lanes.held.len(), 1, "{name}");
        assert_eq!(lanes.held[0].arch, "x86_64");
        assert!(
            lanes.held[0]
                .reason
                .starts_with("needs a person: prep-root.sh installs qemu-user-static-binfmt")
                && lanes.held[0].reason.contains(detail),
            "{name}: {}",
            lanes.held[0].reason
        );
        let c = Capacity::new(
            &facts(ROOTFUL).with_emulation(16, lanes),
            &Caps::default(),
            &constants(),
        );
        let v = serde_json::to_value(c.file("t")).unwrap();
        assert_eq!(
            v["lanes"],
            serde_json::json!([{"arch": "aarch64", "mode": "native"}]),
            "{name}: the native lane is unaffected"
        );
        assert_eq!(v["held_lanes"][0]["arch"], "x86_64");
        assert!(
            preflight(&c).is_empty(),
            "{name}: a held lane is no blocker"
        );
        let _ = std::fs::remove_dir_all(&d);
    }
    // The binfmt handlers as the kernel lists them: qemu's, and Rosetta's for x86_64 only.
    let d = binfmt_tree(
        "emu-rosetta",
        &[(
            "rosetta",
            "enabled\ninterpreter /mnt/lima-rosetta/rosetta\nflags: OCF\n",
        )],
    );
    assert_eq!(
        emulation::binfmt(&d, "x86_64"),
        Binfmt::Ready { via: "rosetta" }
    );
    assert_eq!(emulation::binfmt(&d, "aarch64"), Binfmt::Missing);
    let lanes = studio(&d, None, 16, &FakeSmoke::passing());
    assert_eq!(lanes.on[0].via, "rosetta");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn emulate_empty_in_the_envelope_keeps_every_emulated_lane_off() {
    let d = binfmt_tree("emu-envelope", &[("qemu-x86_64", QEMU_X86_F)]);
    // Told by the envelope: nothing is pulled or run for a lane the owner turned off.
    let smoke = FakeSmoke::passing();
    let lanes = studio(&d, Some(&[]), 16, &smoke);
    assert!(smoke.asked().is_empty());
    assert_eq!(
        lanes,
        Lanes {
            on: vec![],
            held: vec![Held {
                arch: "x86_64".into(),
                reason: "off: the envelope's emulate does not list it".into()
            }]
        }
    );
    // Listed, it runs.
    let smoke = FakeSmoke::passing();
    assert_eq!(
        studio(&d, Some(&["x86_64".to_owned()]), 16, &smoke)
            .on
            .len(),
        1
    );
    assert_eq!(smoke.asked().len(), 1);
    // A lane found on by a probe that was not told: the envelope still holds it off.
    let found = studio(&d, None, 16, &FakeSmoke::passing());
    let c = Capacity::new(
        &facts(ROOTFUL).with_emulation(16, found),
        &Caps {
            emulate: Some(vec![]),
            ..Caps::default()
        },
        &constants(),
    );
    let v = serde_json::to_value(c.file("t")).unwrap();
    assert_eq!(
        v["lanes"],
        serde_json::json!([{"arch": "aarch64", "mode": "native"}])
    );
    assert_eq!(
        v["held_lanes"],
        serde_json::json!([{"arch": "x86_64", "reason": "off: the envelope's emulate does not list it"}])
    );
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn on_a_16k_page_host_the_x86_64_lane_is_on_and_says_page16k() {
    let d = binfmt_tree("emu-16k", &[("qemu-x86_64", QEMU_X86_F)]);
    // A loader that fails there, as sudo does on 16K pages, is not asked: the lane is on
    // anyway (D33), and the builds whose libraries do not map come back (#VM4K).
    let smoke = FakeSmoke::loader_failing("sudo: failed to map segment from shared object");
    let lanes = studio(&d, None, 16, &smoke);
    assert!(smoke.loaded().is_empty(), "no loader check on 16K pages");
    assert_eq!(
        lanes.on,
        [Emulated {
            arch: "x86_64".into(),
            via: "qemu",
            page16k: true
        }],
        "D33: on anyway; a toolchain that cannot start sends its build back"
    );
    let c = Capacity::new(
        &facts(ROOTFUL).with_emulation(16, lanes),
        &Caps::default(),
        &constants(),
    );
    let v = serde_json::to_value(c.file("t")).unwrap();
    assert_eq!(v["page_kb"], 16);
    assert_eq!(
        v["lanes"][1],
        serde_json::json!({"arch": "x86_64", "mode": "emulated", "via": "qemu", "page16k": true})
    );
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn on_4k_pages_a_loader_check_that_fails_holds_the_lane_with_its_reason() {
    // A 4K-page lane is handed the builds 16K pages sent back (#VM4K): one whose loader does
    // not start sudo would fail them all, so it is held, not reported on at 4K pages.
    let d = binfmt_tree("emu-loader", &[("qemu-x86_64", QEMU_X86_F)]);
    let smoke = FakeSmoke::loader_failing(
        "sudo -V: printed \"sudo: error while loading shared libraries\", not \"Sudo version\"",
    );
    let lanes = studio(&d, None, 4, &smoke);
    assert_eq!(smoke.asked().len(), 1);
    assert_eq!(
        smoke.loaded(),
        [("x86_64".to_owned(), X86_IMAGE.to_owned())]
    );
    assert!(lanes.on.is_empty(), "{lanes:?}");
    assert_eq!(lanes.held.len(), 1);
    assert_eq!(lanes.held[0].arch, "x86_64");
    assert!(
        lanes.held[0]
            .reason
            .starts_with("the smoke run failed: sudo -V: ")
            && lanes.held[0]
                .reason
                .ends_with(" — the loader check of a lane on 4K pages (#VM4K)"),
        "{}",
        lanes.held[0].reason
    );
    // In capacity.json: only the native lane, the x86_64 one held with that reason.
    let c = Capacity::new(
        &facts(ROOTFUL).with_emulation(4, lanes),
        &Caps::default(),
        &constants(),
    );
    let v = serde_json::to_value(c.file("t")).unwrap();
    assert_eq!(
        v["lanes"],
        serde_json::json!([{"arch": "aarch64", "mode": "native"}])
    );
    assert_eq!(v["held_lanes"][0]["arch"], "x86_64");
    // A smoke run that already failed asks no loader.
    let smoke = FakeSmoke::failing("exec /usr/bin/true: exec format error");
    let _ = studio(&d, None, 4, &smoke);
    assert!(smoke.loaded().is_empty());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_smoke_run_that_fails_or_cannot_run_holds_the_lane_with_its_reason() {
    let d = binfmt_tree("emu-smoke", &[("qemu-x86_64", QEMU_X86_F)]);
    let lanes = studio(
        &d,
        None,
        4,
        &FakeSmoke::failing("exec /usr/bin/true: exec format error"),
    );
    assert!(lanes.on.is_empty());
    assert_eq!(
        lanes.held[0].reason,
        "the smoke run failed: exec /usr/bin/true: exec format error"
    );
    // No release, no image to run: not checked, and said so.
    let smoke = FakeSmoke::passing();
    let lanes = emulation::detect(
        "aarch64",
        4,
        &emulation::Probe {
            binfmt: &d,
            images: &[],
            emulate: None,
        },
        &smoke,
    );
    assert!(smoke.asked().is_empty());
    assert!(lanes.held[0].reason.starts_with("not checked"), "{lanes:?}");
    // The reverse host: x86_64 native, aarch64 emulated, through the release's aarch64 image
    // (the engine's architecture decides which, whatever the agent binary's is).
    put(
        &d,
        "qemu-aarch64",
        "enabled\ninterpreter /usr/bin/qemu-aarch64-static\nflags: F\n",
    );
    let smoke = FakeSmoke::passing();
    let lanes = emulation::detect(
        "x86_64",
        4,
        &emulation::Probe {
            binfmt: &d,
            images: &release(),
            emulate: None,
        },
        &smoke,
    );
    assert_eq!(lanes.on[0].arch, "aarch64");
    assert_eq!(
        smoke.asked(),
        [("aarch64".to_owned(), ARM_IMAGE.to_owned())]
    );
    let _ = std::fs::remove_dir_all(&d);
}

/// A docker CLI for the smoke run: each call's arguments to `calls`, `pacman --version`
/// printing `pacman_says`, `sudo -V` printing `Sudo version 1.9.17p2`.
fn smoke_docker(dir: &Path, pacman_says: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let d = dir.display();
    let docker = dir.join("docker");
    put(
        dir,
        "docker",
        &format!(
            "#!/bin/sh\necho \"$*\" >> '{d}/calls'\ncase \" $* \" in\n  *\" --entrypoint pacman \"*) echo '{pacman_says}' ;;\n  *\" --entrypoint sudo \"*) echo 'Sudo version 1.9.17p2' ;;\n  *\" --entrypoint /usr/bin/true \"*) ;;\n  *) exit 2 ;;\nesac\n"
        ),
    );
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
    docker
}

#[test]
fn the_smoke_run_starts_true_then_pacman_under_the_lane_platform_by_digest() {
    let dir = tmp("smoke-docker");
    let docker = smoke_docker(&dir, " .--.  Pacman v7.0.0 - libalpm v15.0.0");
    let p = probe::Probe {
        docker: docker.to_str().unwrap(),
        host: Some("unix:///run/docker.sock"),
        work_root: &dir,
        image: None,
        emulation: None,
        sandbox: None,
    };
    p.emulation("x86_64", X86_IMAGE).unwrap();
    let calls = std::fs::read_to_string(dir.join("calls")).unwrap();
    assert_eq!(
        calls.lines().collect::<Vec<_>>(),
        [
            format!("--host unix:///run/docker.sock run --rm --network none --platform linux/amd64 --entrypoint /usr/bin/true {X86_IMAGE}"),
            format!("--host unix:///run/docker.sock run --rm --network none --platform linux/amd64 --entrypoint pacman {X86_IMAGE} --version"),
        ]
    );
    // A pacman that does not answer as pacman fails the lane.
    let dir2 = tmp("smoke-docker-bad");
    let docker = smoke_docker(&dir2, "sh: pacman: not found");
    let p = probe::Probe {
        docker: docker.to_str().unwrap(),
        ..p
    };
    assert!(p
        .emulation("aarch64", X86_IMAGE)
        .unwrap_err()
        .contains("not \"Pacman v\""));
    assert!(std::fs::read_to_string(dir2.join("calls"))
        .unwrap()
        .contains("--platform linux/arm64"));
    // Nothing outside the grammar reaches the argv: an image by tag, a flag, an arch.
    std::fs::remove_file(dir2.join("calls")).unwrap();
    for (arch, image) in [
        ("x86_64", "docker.io/library/archlinux:latest"),
        (
            "x86_64",
            "--privileged@sha256:b944cc65c5f28665dfd5fdbf5ed2997c88f5bb4a0aefac7ee8a7ef01893e5ed9",
        ),
        ("x86_64", "archlinux@sha256:abc"),
        ("riscv64", X86_IMAGE),
    ] {
        assert!(p.emulation(arch, image).is_err(), "{arch} {image}");
    }
    assert!(!dir2.join("calls").exists(), "refused before docker ran");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

#[test]
fn the_loader_check_runs_sudo_v_under_the_lane_platform_by_digest() {
    let dir = tmp("loader-docker");
    let docker = smoke_docker(&dir, "Pacman v7.0.0 - libalpm v15.0.0");
    let p = probe::Probe {
        docker: docker.to_str().unwrap(),
        host: None,
        work_root: &dir,
        image: None,
        emulation: None,
        sandbox: None,
    };
    p.loader("x86_64", X86_IMAGE).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("calls")).unwrap().trim(),
        format!("run --rm --network none --platform linux/amd64 --entrypoint sudo {X86_IMAGE} -V")
    );
    // Nothing outside the grammar reaches the argv.
    std::fs::remove_file(dir.join("calls")).unwrap();
    assert!(p
        .loader("x86_64", "docker.io/library/archlinux:base-devel")
        .is_err());
    assert!(p.loader("riscv64", X86_IMAGE).is_err());
    assert!(!dir.join("calls").exists(), "refused before docker ran");
    // A sudo that is not there, or does not load, fails it with what it said.
    put(
        &dir,
        "docker",
        "#!/bin/sh\necho 'sudo: error while loading shared libraries: failed to map segment from shared object' >&2\nexit 127\n",
    );
    let e = p.loader("x86_64", X86_IMAGE).unwrap_err();
    assert!(e.starts_with("sudo: "), "{e}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn detection_runs_the_emulated_lane_through_the_engine_with_the_envelope() {
    // The whole probe on a fake engine: `docker info`, the probe container, then the smoke.
    let dir = tmp("detect-emu");
    let docker = fake_docker(&dir, 0);
    let bin = binfmt_tree("detect-emu-binfmt", &[("qemu-x86_64", QEMU_X86_F)]);
    let images = release();
    let p = probe::Probe {
        docker: docker.to_str().unwrap(),
        host: None,
        work_root: &dir,
        image: Some("build-image"),
        emulation: Some(emulation::Probe {
            binfmt: &bin,
            images: &images,
            emulate: None,
        }),
        sandbox: None,
    };
    // The fake engine prints no pacman: the lane is held with what the smoke run saw.
    let f = probe::detect(&p).unwrap();
    let e = f.emulation().unwrap();
    assert!(
        e.on.is_empty() && e.held[0].reason.starts_with("the smoke run failed"),
        "{e:?}"
    );
    assert_eq!(f.report()["emulation"]["held_lanes"][0]["arch"], "x86_64");
    // Off in the envelope: no smoke run at all.
    let p = probe::Probe {
        emulation: Some(emulation::Probe {
            binfmt: &bin,
            images: &images,
            emulate: Some(&[]),
        }),
        ..p
    };
    let f = probe::detect(&p).unwrap();
    assert_eq!(
        f.emulation().unwrap().held[0].reason,
        "off: the envelope's emulate does not list it"
    );
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&bin);
}

#[test]
fn the_smoke_runs_images_are_the_releases_by_architecture_or_one_given_by_hand() {
    let m = match manifest::parse(include_bytes!(
        "../../tests/fixtures/manifest/v2-example.json"
    )) {
        Ok(Parsed::Current(m)) => *m,
        other => panic!("the example manifest must read whole: {other:?}"),
    };
    let images = emulation::images(None, Some(&m));
    let want: Vec<(&str, String)> = ["aarch64", "x86_64"]
        .into_iter()
        .map(|a| (a, m.build_image(a).unwrap().to_string()))
        .collect();
    assert_eq!(images, want);
    assert!(emulation::images(None, None).is_empty(), "no release, none");
    // `--emulate-image`: the foreign architecture's, whichever the engine's is.
    assert!(emulation::images(Some(X86_IMAGE), Some(&m))
        .iter()
        .all(|(_, i)| i == X86_IMAGE));
}

/// `run/capacity.json` as this agent writes it, and as the dispatcher reads it
/// (`crates/pkg-repo` `dispatch::capacity`, its claim, the pool's `parseCapacity`): the
/// Studio's `x86_64` lane on through qemu on 16K pages, and an `x86_64` host whose
/// `aarch64` lane is held for a person. Both crates test against these files, so a field renamed on
/// one side fails the other (#338).
const EMULATED_LANE_FILE: &str = include_str!("../../tests/fixtures/capacity/emulated-lane.json");
const HELD_LANE_FILE: &str = include_str!("../../tests/fixtures/capacity/held-lane.json");

#[test]
fn capacity_json_with_its_lanes_is_the_file_the_dispatcher_tests_against() {
    let check = |fixture: &str, c: &Capacity| {
        let want: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let at = want["at"].as_str().unwrap();
        assert_eq!(serde_json::to_value(c.file(at)).unwrap(), want);
    };
    let dedicated = Caps {
        dedicated: true,
        ..Caps::default()
    };
    let d = binfmt_tree("emu-file", &[("qemu-x86_64", QEMU_X86_F)]);
    let lanes = studio(&d, None, 16, &FakeSmoke::passing());
    check(
        EMULATED_LANE_FILE,
        &Capacity::new(
            &facts(ROOTFUL).with_emulation(16, lanes),
            &dedicated,
            &constants(),
        ),
    );
    put(
        &d,
        "qemu-aarch64",
        "disabled\ninterpreter /usr/bin/qemu-aarch64-static\nflags: F\n",
    );
    let lanes = emulation::detect(
        "x86_64",
        4,
        &emulation::Probe {
            binfmt: &d,
            images: &release(),
            emulate: None,
        },
        &FakeSmoke::passing(),
    );
    check(
        HELD_LANE_FILE,
        &Capacity::new(
            &facts(ROOTLESS_DOCKER).with_emulation(4, lanes),
            &dedicated,
            &constants(),
        ),
    );
    let _ = std::fs::remove_dir_all(&d);
}

// ---------- the sandboxed runtime for community tasks (#330, D43) ----------

/// The Studio after `runsc install`: docker lists gVisor beside its runc, and says its kernel.
const ROOTFUL_RUNSC: &str = r#"{"ID":"x","NCPU":12,"MemTotal":33443418112,"DockerRootDir":"/var/lib/docker",
 "Architecture":"aarch64","OSType":"linux","CgroupDriver":"systemd","CgroupVersion":"2",
 "MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true,"KernelVersion":"6.16.8-asahi",
 "SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"],
 "Runtimes":{"io.containerd.runc.v2":{"path":"runc","status":{"x":"y"}},"runc":{"path":"runc"},
   "runsc":{"path":"/usr/local/bin/runsc"},"kata":{"runtimeType":"io.containerd.kata.v2"}}}"#;

const AARCH64_IMAGE: &str = "docker.io/menci/archlinuxarm@sha256:0b3df26cb6b6b9cb26d8d2e3cbd9a8fcbb83d1db0dd0c3cd4f6e2ca7c4c5d6e7";

#[test]
fn docker_info_lists_the_runtimes_and_says_its_kernel() {
    let e = probe::parse_info(ROOTFUL_RUNSC).unwrap();
    assert_eq!(e.kernel, "6.16.8-asahi");
    let names: Vec<(&str, &str, &str)> = e
        .runtimes
        .iter()
        .map(|l| (l.name.as_str(), l.path.as_str(), l.shim.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("io.containerd.runc.v2", "runc", ""),
            ("kata", "", "io.containerd.kata.v2"),
            ("runc", "runc", ""),
            ("runsc", "/usr/local/bin/runsc", ""),
        ]
    );
    // An engine that lists none (an older docker, a test's): nothing to look for.
    let e = probe::parse_info(ROOTFUL).unwrap();
    assert!(e.runtimes.is_empty() && e.kernel.is_empty());
}

/// A docker CLI that keeps its calls: `uname -r` prints `kernel` under `--runtime`, the
/// host's without; `pacman --version` answers.
fn sandbox_docker(dir: &Path, kernel: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    put(dir, "info.json", ROOTFUL_RUNSC);
    let d = dir.display();
    let docker = dir.join("docker");
    put(
        dir,
        "docker",
        &format!(
            r#"#!/bin/sh
case "$1" in
info) cat '{d}/info.json'; exit 0 ;;
esac
echo "$*" >> '{d}/calls'
case " $* " in
  *" --entrypoint uname "*) case " $* " in *" --runtime "*) echo '{kernel}' ;; *) echo 6.16.8-asahi ;; esac ;;
  *" --entrypoint pacman "*) echo 'Pacman v7.0.0 - libalpm v15.0.0' ;;
  *" --entrypoint sh "*) printf 'cpu.max=50000 100000\nmemory.max=67108864\npids.max=32\npagesize=16384\n'; printf 'overlay 1 1 52428800 1%% /\n' ;;
  *) exit 2 ;;
esac
"#
        ),
    );
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
    docker
}

#[test]
fn the_sandboxs_smoke_run_prints_its_kernel_under_the_runtime_by_digest() {
    use sandbox::Run as _;
    let dir = tmp("sandbox-smoke");
    let docker = sandbox_docker(&dir, "4.19.0-gvisor");
    let p = probe::Probe {
        docker: docker.to_str().unwrap(),
        host: Some("unix:///run/docker.sock"),
        work_root: &dir,
        image: None,
        emulation: None,
        sandbox: None,
    };
    assert_eq!(p.sandbox("runsc", AARCH64_IMAGE).unwrap(), "4.19.0-gvisor");
    let calls = std::fs::read_to_string(dir.join("calls")).unwrap();
    assert_eq!(
        calls.lines().collect::<Vec<_>>(),
        [
            format!("--host unix:///run/docker.sock run --rm --network none --runtime runsc --entrypoint uname {AARCH64_IMAGE} -r"),
            format!("--host unix:///run/docker.sock run --rm --network none --runtime runsc --entrypoint pacman {AARCH64_IMAGE} --version"),
        ]
    );
    // Nothing outside the grammar reaches the argv: a flag for a name, an image by tag.
    std::fs::remove_file(dir.join("calls")).unwrap();
    assert!(p.sandbox("--privileged", AARCH64_IMAGE).is_err());
    assert!(p
        .sandbox("runsc", "docker.io/library/archlinux:latest")
        .is_err());
    assert!(!dir.join("calls").exists(), "refused before docker ran");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn detection_finds_gvisor_through_the_engine_and_the_file_carries_it() {
    let dir = tmp("sandbox-detect");
    let probe_with = |docker: &Path, setting: &sandbox::Setting| -> Facts {
        probe::detect(&probe::Probe {
            docker: docker.to_str().unwrap(),
            host: None,
            work_root: &dir,
            image: Some(AARCH64_IMAGE),
            emulation: None,
            sandbox: Some(sandbox::Probe {
                setting,
                local: false,
            }),
        })
        .unwrap()
    };
    let docker = sandbox_docker(&dir, "4.19.0-gvisor");
    let f = probe_with(&docker, &sandbox::Setting::Auto);
    let want = sandbox::Sandbox {
        runtime: "runsc".into(),
        kind: sandbox::Kind::Gvisor,
    };
    assert_eq!(f.sandbox().unwrap().on.as_ref(), Some(&want));
    assert_eq!(
        f.report()["sandbox"],
        serde_json::json!({"runtime": "runsc", "kind": "gvisor"})
    );
    let c = Capacity::new(&f, &Caps::default(), &constants());
    assert_eq!(c.sandbox(), Some(&want));
    let file = serde_json::to_value(c.file("t")).unwrap();
    assert_eq!(
        file["sandbox"],
        serde_json::json!({"runtime": "runsc", "kind": "gvisor"})
    );
    assert!(file.get("sandbox_held").is_none());
    assert!(
        !preflight(&c).iter().any(|b| b.contains("sandbox")),
        "a sandbox is never a blocker"
    );
    // The envelope's `off`: nothing run for it, `sandbox: null` in the file.
    std::fs::remove_file(dir.join("calls")).unwrap();
    let f = probe_with(&docker, &sandbox::Setting::Off);
    assert!(!std::fs::read_to_string(dir.join("calls"))
        .unwrap()
        .contains("--runtime"));
    let file =
        serde_json::to_value(Capacity::new(&f, &Caps::default(), &constants()).file("t")).unwrap();
    assert_eq!(file["sandbox"], serde_json::Value::Null);
    // docker's CLI on podman runs podman's own runtime under `--runtime runsc`: the host's kernel, no sandbox.
    let podman = sandbox_docker(&tmp("sandbox-podman"), "6.16.8-asahi");
    let f = probe_with(&podman, &sandbox::Setting::Auto);
    let c = Capacity::new(&f, &Caps::default(), &constants());
    assert_eq!(c.sandbox(), None);
    assert!(
        c.sandbox_held()
            .unwrap()
            .starts_with("runsc: its container ran on the engine's own kernel (6.16.8-asahi)"),
        "{:?}",
        c.sandbox_held()
    );
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(podman.parent().unwrap());
}

#[test]
fn the_envelope_keeps_a_sandbox_detection_found_out_whatever_the_probe_was_told() {
    let found = sandbox::Found {
        on: Some(sandbox::Sandbox {
            runtime: "runsc".into(),
            kind: sandbox::Kind::Gvisor,
        }),
        held: None,
    };
    let f = facts(ROOTFUL).with_sandbox(found);
    let with = |s: sandbox::Setting| {
        Capacity::new(
            &f,
            &Caps {
                sandbox: s,
                ..Caps::default()
            },
            &constants(),
        )
    };
    assert_eq!(
        with(sandbox::Setting::Auto).sandbox().unwrap().runtime,
        "runsc"
    );
    assert_eq!(
        with(sandbox::Setting::Named("runsc".into()))
            .sandbox()
            .unwrap()
            .runtime,
        "runsc"
    );
    let off = with(sandbox::Setting::Off);
    assert!(off.sandbox().is_none() && off.sandbox_held().is_none());
    let other = with(sandbox::Setting::Named("kata".into()));
    assert!(other.sandbox().is_none());
    assert_eq!(
        other.sandbox_held(),
        Some("runsc: not the runtime the envelope's sandbox names (kata)")
    );
    // Detection that did not look (no probe for it): `sandbox: null`.
    let none = Capacity::new(&facts(ROOTFUL), &Caps::default(), &constants());
    assert_eq!(
        serde_json::to_value(none.file("t")).unwrap()["sandbox"],
        serde_json::Value::Null
    );
}

/// The Studio with gVisor (#330): its `x86_64` lane emulated as before, `runsc` for the
/// community tasks of its native lane. The dispatcher's tests and the pool's read this file.
const SANDBOXED_FILE: &str = include_str!("../../tests/fixtures/capacity/sandboxed.json");

#[test]
fn capacity_json_with_its_sandbox_is_the_file_the_dispatcher_and_the_pool_test_against() {
    let want: serde_json::Value = serde_json::from_str(SANDBOXED_FILE).unwrap();
    let d = binfmt_tree("sandbox-file", &[("qemu-x86_64", QEMU_X86_F)]);
    let lanes = studio(&d, None, 16, &FakeSmoke::passing());
    let f = facts(ROOTFUL)
        .with_emulation(16, lanes)
        .with_sandbox(sandbox::Found {
            on: Some(sandbox::Sandbox {
                runtime: "runsc".into(),
                kind: sandbox::Kind::Gvisor,
            }),
            held: None,
        });
    let c = Capacity::new(
        &f,
        &Caps {
            dedicated: true,
            ..Caps::default()
        },
        &constants(),
    );
    assert_eq!(
        serde_json::to_value(c.file(want["at"].as_str().unwrap())).unwrap(),
        want
    );
    let _ = std::fs::remove_dir_all(&d);
}
