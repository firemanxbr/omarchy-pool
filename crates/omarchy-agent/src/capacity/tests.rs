use std::path::{Path, PathBuf};

use super::probe::{self, CgroupLimits, Engine, Facts};
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
            "isolation": "root", "dedicated": true,
            "limits": {"cpus_hard": true, "memory_hard": true, "pids": true},
            "below_minimum": false
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
        }
    );
    assert_eq!(a.work_root.as_deref(), Some("/srv/omarchy-pool/host"));
    assert_eq!(a.emulate, Some(vec!["x86_64".to_owned()]));
    assert_eq!(AgentToml::parse("").unwrap().caps, Caps::default());
    assert_eq!(AgentToml::parse("").unwrap().emulate, None);
    assert!(AgentToml::parse("[envelope]\nmax_units = -1\n").is_err());
    assert!(AgentToml::parse("[envelope]\nmax_units = \"all\"\n").is_err());
    // A misspelt cap is refused, not silently dropped; every key of §12 reads.
    assert!(AgentToml::parse("[envelope]\nmax_unit = 5\n").is_err());
    assert!(AgentToml::parse(
        "[envelope]\nallow_socket = true\nrootful_ack = true\nuserns_remap = false\n\
         paths = []\ndrivers = [\"compose\"]\ncache_caps = { build_gb = 120 }\n\
         agent_budget = { calls_per_task = 200 }\ntask_subnets = \"10.232.0.0/16\"\n\
         diagnostics = false\nsoak_minutes = 0\n"
    )
    .is_ok());
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
        serde_json::json!([{"arch": "aarch64", "mode": "native"}, {"arch": "x86_64", "mode": "emulated", "via": "rosetta"}])
    );
    // `emulate = []` leaves the lane off, whatever the VM runs: no count widens it.
    let (f, said) = in_mac_vm(host(8, 32), &vm(Some(&NONE), true), &mut smoke);
    assert!(f.emulated.is_empty());
    assert_eq!(
        said,
        Some(LaneSaid::Note(
            "the x86_64 lane is off: the envelope's emulate leaves it out".into()
        ))
    );
    assert_eq!(smokes.len(), 1, "no smoke run for a lane left out");
    // A smoke run that fails: no lane, a warning.
    let (f, said) = in_mac_vm(host(8, 32), &vm(None, true), &mut |_| Err("exit 1".into()));
    assert!(f.emulated.is_empty());
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
