//! The dispatcher's loop against a fake engine and a fake pool (#335): every
//! transition of a lease, a restart of the dispatcher at every point of one,
//! stale generations, the pool's outage, the disk watcher, the outputs'
//! closed list, the engine's out-of-memory kill, the claims and the orders.
//! Preparations and finishes run in the loop's own thread here (`inline`).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::capacity::Constants;
use super::engine::{Engine, State};
use super::kinds::Ctx;
use super::lease::{Lease, Phase, Store};
use super::pool::Pool;
use super::spec::{self, HOST_LABEL};
use super::{Dispatcher, Images, Probes, Timing};
use crate::stop::Beat;
use crate::RepoError;

const GEN: &str = "g_00000000000000a1";
const GEN2: &str = "g_00000000000000b2";
const HOST: &str = "h_test";
const IMAGE: &str = "docker.io/library/archlinux@sha256:51dd3d24f7fba779e7c471caeee7804c50e8c134ad948e19685a1c83a42facc3";

// ---------- the fake engine ----------

/// A container: its state, its host label, the arguments it was started with (none for one put there by hand).
type Container = (State, String, Vec<String>);

#[derive(Default)]
struct FakeEngine {
    containers: Mutex<BTreeMap<String, Container>>,
    runs: Mutex<Vec<Vec<String>>>,
    removed: Mutex<Vec<(u64, String)>>,
    /// `inspect` gets no answer (a busy daemon).
    deaf: AtomicBool,
}

impl FakeEngine {
    fn put(&self, name: &str, status: &str, host: &str) {
        self.containers.lock().unwrap().insert(
            name.to_owned(),
            (
                State {
                    status: status.into(),
                    ..State::default()
                },
                host.into(),
                Vec::new(),
            ),
        );
    }
    fn exit(&self, id: u64, gen: &str, code: i32, oom: bool) {
        let mut c = self.containers.lock().unwrap();
        let e = c
            .get_mut(&spec::container_name(id, gen))
            .expect("the container exists");
        e.0 = State {
            status: "exited".into(),
            exit_code: code,
            oom_killed: oom,
        };
    }
    fn has(&self, id: u64, gen: &str) -> bool {
        self.containers
            .lock()
            .unwrap()
            .contains_key(&spec::container_name(id, gen))
    }
    fn args(&self, id: u64, gen: &str) -> Vec<String> {
        self.containers.lock().unwrap()[&spec::container_name(id, gen)]
            .2
            .clone()
    }
}

impl Engine for FakeEngine {
    fn run(&self, args: &[String]) -> Result<(), String> {
        let name = args[args.iter().position(|a| a == "--name").unwrap() + 1].clone();
        let host = args
            .iter()
            .find_map(|a| a.strip_prefix(&format!("{HOST_LABEL}=")))
            .unwrap_or_default()
            .to_owned();
        let mut c = self.containers.lock().unwrap();
        if c.contains_key(&name) {
            return Err(format!("the name {name} is in use"));
        }
        c.insert(
            name,
            (
                State {
                    status: "running".into(),
                    ..State::default()
                },
                host,
                args.to_vec(),
            ),
        );
        self.runs.lock().unwrap().push(args.to_vec());
        Ok(())
    }
    fn inspect(&self, name: &str) -> Result<Option<State>, String> {
        if self.deaf.load(Ordering::SeqCst) {
            return Err("the engine does not answer".into());
        }
        Ok(self
            .containers
            .lock()
            .unwrap()
            .get(name)
            .map(|c| c.0.clone()))
    }
    fn list(&self, host: &str) -> Result<Vec<String>, String> {
        Ok(self
            .containers
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, c)| c.1 == host)
            .map(|(n, _)| n.clone())
            .collect())
    }
    fn remove_lease(&self, task: u64, gen: &str) {
        // By its labels: a container this lease started (a stranger without them is not found this way).
        let name = spec::container_name(task, gen);
        let mut c = self.containers.lock().unwrap();
        if c.get(&name).is_some_and(|x| !x.2.is_empty()) {
            c.remove(&name);
        }
        self.removed.lock().unwrap().push((task, gen.to_owned()));
    }
    fn remove_name(&self, name: &str) {
        self.containers.lock().unwrap().remove(name);
    }
}

// ---------- the fake pool ----------

#[derive(Clone)]
enum Answer {
    Body(Option<Value>),
    Down,
}

#[derive(Clone, PartialEq)]
enum BeatMode {
    Ok,
    Renew(String),
    Stop(String),
    /// This lease's heartbeats are not heard.
    Down,
}

#[derive(Default)]
struct FakePool {
    claims: Mutex<VecDeque<Answer>>,
    claim_bodies: Mutex<Vec<Value>>,
    beats: Mutex<HashMap<u64, BeatMode>>,
    beat_tokens: Mutex<Vec<(u64, String)>>,
    completes: Mutex<Vec<(u64, String, Value)>>,
    fails: Mutex<Vec<(u64, Value)>>,
    staged: Mutex<Vec<(u64, String)>>,
    artifacts: Mutex<HashMap<(u64, String), Vec<u8>>>,
    published: Mutex<Vec<(String, String, usize)>>,
    events: Mutex<Vec<Value>>,
    answers: Mutex<Vec<(String, Value)>>,
    /// Every lease call fails as a pool that does not answer.
    down: AtomicBool,
    /// Uploads are refused with this status.
    refuse_uploads: Mutex<Option<u16>>,
}

fn down() -> RepoError {
    RepoError::Api {
        status: 503,
        body: "the pool is down".into(),
    }
}

impl FakePool {
    fn answer(&self, a: Answer) {
        self.claims.lock().unwrap().push_back(a);
    }
    fn fails_of(&self, id: u64) -> Vec<Value> {
        self.fails
            .lock()
            .unwrap()
            .iter()
            .filter(|(i, _)| *i == id)
            .map(|(_, b)| b.clone())
            .collect()
    }
    fn completes_of(&self, id: u64) -> Vec<Value> {
        self.completes
            .lock()
            .unwrap()
            .iter()
            .filter(|(i, _, _)| *i == id)
            .map(|(_, _, b)| b.clone())
            .collect()
    }
    fn staged_of(&self, id: u64) -> Vec<String> {
        self.staged
            .lock()
            .unwrap()
            .iter()
            .filter(|(i, _)| *i == id)
            .map(|(_, n)| n.clone())
            .collect()
    }
    fn last_claim(&self) -> Value {
        self.claim_bodies.lock().unwrap().last().cloned().unwrap()
    }
}

impl Pool for FakePool {
    fn claim(&self, body: &Value) -> Result<Option<Value>, RepoError> {
        self.claim_bodies.lock().unwrap().push(body.clone());
        match self
            .claims
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Answer::Body(None))
        {
            Answer::Body(b) => Ok(b),
            Answer::Down => Err(down()),
        }
    }
    fn whoami(&self) -> Result<String, RepoError> {
        Ok(HOST.into())
    }
    fn answer(&self, order: &str, body: &Value) -> Result<(), RepoError> {
        self.answers
            .lock()
            .unwrap()
            .push((order.into(), body.clone()));
        Ok(())
    }
    fn heartbeat(&self, task: u64, token: &str) -> Beat {
        self.beat_tokens.lock().unwrap().push((task, token.into()));
        if self.down.load(Ordering::SeqCst) {
            return Beat::Nothing;
        }
        match self
            .beats
            .lock()
            .unwrap()
            .get(&task)
            .cloned()
            .unwrap_or(BeatMode::Ok)
        {
            BeatMode::Ok => Beat::Accepted(None),
            BeatMode::Renew(t) => Beat::Accepted(Some(t)),
            BeatMode::Stop(s) => Beat::Stop(s),
            BeatMode::Down => Beat::Nothing,
        }
    }
    fn complete(&self, task: u64, token: &str, body: &Value) -> Result<(), RepoError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(down());
        }
        self.completes
            .lock()
            .unwrap()
            .push((task, token.into(), body.clone()));
        Ok(())
    }
    fn fail(&self, task: u64, _token: &str, body: &Value) -> Result<(), RepoError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(down());
        }
        self.fails.lock().unwrap().push((task, body.clone()));
        Ok(())
    }
    fn stage(&self, _token: &str, to: u64, name: &str, file: &Path) -> Result<(), RepoError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(down());
        }
        if let Some(status) = *self.refuse_uploads.lock().unwrap() {
            return Err(RepoError::Api {
                status,
                body: "staging quota reached".into(),
            });
        }
        assert!(file.is_file(), "an upload reads a file: {}", file.display());
        self.staged.lock().unwrap().push((to, name.into()));
        Ok(())
    }
    fn fetch(&self, _token: &str, of: u64, name: &str, dest: &Path) -> Result<bool, RepoError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(down());
        }
        match self.artifacts.lock().unwrap().get(&(of, name.to_owned())) {
            Some(b) => {
                std::fs::write(dest, b).unwrap();
                Ok(true)
            }
            None => Ok(false),
        }
    }
    fn fetch_private(
        &self,
        token: &str,
        of: u64,
        name: &str,
        dest: &Path,
    ) -> Result<(), RepoError> {
        if self.fetch(token, of, name, dest)? {
            Ok(())
        } else {
            Err(RepoError::Api {
                status: 404,
                body: "none".into(),
            })
        }
    }
    fn post_event(&self, _token: &str, event: &Value) -> Result<(), RepoError> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
    fn publish(
        &self,
        _token: &str,
        ring: &str,
        arch: &str,
        _note: &str,
        pkgs: &[PathBuf],
        both: bool,
    ) -> anyhow::Result<Vec<String>> {
        self.published
            .lock()
            .unwrap()
            .push((ring.into(), arch.into(), pkgs.len()));
        let mut r = vec![format!("omarchy-factory-{ring}/{arch}")];
        if both {
            r.push(format!("omarchy-factory-{ring}/other"));
        }
        Ok(r)
    }
    fn api_url(&self) -> &'static str {
        "http://127.0.0.1:1"
    }
}

// ---------- the clock and the host ----------

struct FakeProbes {
    now: Arc<AtomicU64>,
    work: Arc<Mutex<Option<u64>>>,
}

impl Probes for FakeProbes {
    fn now(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn work_free_gb(&self) -> Option<u64> {
        *self.work.lock().unwrap()
    }
    fn mem_available_gb(&self) -> Option<u64> {
        None
    }
}

// ---------- the harness ----------

struct H {
    _t: tempfile::TempDir,
    work: PathBuf,
    checkout: PathBuf,
    capacity: PathBuf,
    engine: Arc<FakeEngine>,
    pool: Arc<FakePool>,
    now: Arc<AtomicU64>,
    free: Arc<Mutex<Option<u64>>>,
}

impl H {
    fn new() -> Self {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        let work = root.join("work");
        let checkout = root.join("checkout");
        std::fs::create_dir_all(checkout.join("factory/worker")).unwrap();
        std::fs::write(
            checkout.join("factory/worker/omarchy-build-worker.sh"),
            "#!/bin/bash\n",
        )
        .unwrap();
        let h = Self {
            capacity: root.join("capacity.json"),
            work,
            checkout,
            _t: t,
            engine: Arc::new(FakeEngine::default()),
            pool: Arc::new(FakePool::default()),
            now: Arc::new(AtomicU64::new(1_000_000)),
            free: Arc::new(Mutex::new(Some(500))),
        };
        h.units(11);
        h
    }

    fn units(&self, units: u32) {
        std::fs::write(&self.capacity, json!({"schema":2,"at":"2026-10-01T00:00:00Z","cpus":12,"mem_gb":32,"page_kb":16,"disk_free_gb":{"work":200,"engine":150},"units":units,"job_reserved":1,"agent_slots":1,"lanes":[{"arch":"aarch64","mode":"native"}],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}).to_string()).unwrap();
    }

    /// A dispatcher on this host: a new one is a restart (the engine and the lease files stay).
    fn dispatcher(&self) -> Dispatcher {
        let pool: Arc<dyn Pool> = self.pool.clone();
        let ctx = Ctx {
            pool,
            work_root: self.work.clone(),
            pool_url: "https://pool.example".into(),
            checkout: Some(self.checkout.clone()),
            constants: Constants::signed(),
        };
        let mut d = Dispatcher::new(
            ctx,
            self.engine.clone(),
            Box::new(FakeProbes {
                now: Arc::clone(&self.now),
                work: Arc::clone(&self.free),
            }),
            Timing::default(),
            HOST.into(),
            self.capacity.clone(),
            Images {
                aarch64: IMAGE.into(),
                x86_64: IMAGE.into(),
            },
            None,
            true,
        )
        .unwrap();
        d.readopt().unwrap();
        d
    }

    /// A new dispatcher's re-adoption, which must fail (the engine does not answer).
    fn dispatcher_readopt_fails(&self) -> bool {
        let pool: Arc<dyn Pool> = self.pool.clone();
        let ctx = Ctx {
            pool,
            work_root: self.work.clone(),
            pool_url: "https://pool.example".into(),
            checkout: Some(self.checkout.clone()),
            constants: Constants::signed(),
        };
        let mut d = Dispatcher::new(
            ctx,
            self.engine.clone(),
            Box::new(FakeProbes {
                now: Arc::clone(&self.now),
                work: Arc::clone(&self.free),
            }),
            Timing::default(),
            HOST.into(),
            self.capacity.clone(),
            Images {
                aarch64: IMAGE.into(),
                x86_64: IMAGE.into(),
            },
            None,
            true,
        )
        .unwrap();
        d.readopt().is_err()
    }

    fn advance(&self, secs: u64) {
        self.now.fetch_add(secs, Ordering::SeqCst);
    }

    fn ticks(&self, d: &mut Dispatcher, n: usize) {
        for _ in 0..n {
            d.tick();
            self.advance(3);
        }
    }

    fn give(&self, task: Value) {
        self.pool.answer(Answer::Body(Some(task)));
    }

    fn tdir(&self, id: u64, gen: &str) -> PathBuf {
        spec::task_dir(&self.work, id, gen)
    }

    /// What a build container leaves, then its exit.
    fn leave(&self, id: u64, gen: &str, files: &[(&str, Vec<u8>)], log: &str) {
        let d = self.tdir(id, gen);
        for (n, b) in files {
            std::fs::write(d.join("out").join(n), b).unwrap();
        }
        std::fs::write(d.join("log/task.log"), log).unwrap();
    }

    fn leases(&self) -> Vec<Lease> {
        Store::open(&self.work).unwrap().load().unwrap().leases
    }
}

#[allow(clippy::needless_pass_by_value)] // the call sites read better with json!(…) inline
fn task(
    id: u64,
    kind: &str,
    name: &str,
    reference: &str,
    trust: &str,
    params: Value,
    gen: &str,
) -> Value {
    json!({
        "task": { "id": id, "kind": kind, "name": name, "arch": "aarch64", "trust": trust, "pkgbuild_ref": reference, "params": params,
                  "attempts": 1, "max_attempts": 3, "publish": 1, "lease_gen": gen, "units": if kind == "audit" { 1 } else { 2 }, "disk_gb": if kind == "build" { 20 } else { 0 }, "release": "v1.2.3" },
        "token": format!("omj.secret-of-{id}"),
        "lease_minutes": 30,
    })
}

fn community(id: u64, gen: &str) -> Value {
    task(
        id,
        "build",
        "felix",
        "https://github.com/felix/felix@v1.0:PKGBUILD",
        "community",
        json!({}),
        gen,
    )
}

/// A package as makepkg writes one, enough for pkg-extract: a tar with its .PKGINFO.
fn package(name: &str) -> Vec<u8> {
    let info = format!("pkgname = {name}\npkgver = 1.0-1\narch = aarch64\nsize = 1\n");
    let mut b = tar::Builder::new(Vec::new());
    let mut h = tar::Header::new_gnu();
    h.set_size(info.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    b.append_data(&mut h, ".PKGINFO", info.as_bytes()).unwrap();
    b.into_inner().unwrap()
}

fn built_ok() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("felix-1.0-1-aarch64.pkg.tar.zst", package("felix")),
        ("PKGBUILD", b"pkgname=felix".to_vec()),
        ("vet.json", br#"{"verdict":"pass"}"#.to_vec()),
        (
            "verdict.json",
            br#"{"status":0,"final":false,"needs_native":false,"error":""}"#.to_vec(),
        ),
    ]
}

// ---------- the tests ----------

#[test]
fn a_community_build_runs_staged_in_and_out_and_its_container_holds_nothing() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    assert!(h.engine.has(7, GEN), "its container started");
    let args = h.engine.args(7, GEN);
    let all = args.join(" ");
    assert!(
        !all.contains("omj.") && !all.contains("secret"),
        "no token in a task container: {all}"
    );
    assert!(
        !all.contains("docker.sock")
            && !all.contains("--rm")
            && !all.contains(&format!("{}:", h.work.display()))
    );
    assert!(all.contains(&format!(
        "{}:/task/in:ro",
        h.tdir(7, GEN).join("in").display()
    )));
    assert!(
        all.contains("--cpus 2") && all.contains("--memory 4g"),
        "its units' share: {all}"
    );
    assert!(all.contains(&format!("{}:/pool:ro", h.checkout.display())));
    // What it was given: meta.sh, and no token, key or pool address in it.
    let meta = std::fs::read_to_string(h.tdir(7, GEN).join("in/meta.sh")).unwrap();
    assert!(
        meta.contains("staged=1")
            && meta.contains("name='felix'")
            && meta.contains("pool='https://pool.example'"),
        "{meta}"
    );
    assert!(
        !meta.contains("omj.") && !meta.contains("OMARCHY_API"),
        "{meta}"
    );
    let lease = &h.leases()[0];
    assert_eq!(lease.phase, Phase::Running);
    let mode = std::os::unix::fs::PermissionsExt::mode(
        &std::fs::metadata(h.work.join(format!("state/leases/7-{GEN}.json")))
            .unwrap()
            .permissions(),
    );
    assert_eq!(mode & 0o777, 0o600);

    h.leave(7, GEN, &built_ok(), "==> Finished making: felix\n");
    h.engine.exit(7, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(
        h.pool.staged_of(7),
        [
            "PKGBUILD",
            "build.log",
            "vet.json",
            "PKGINFO",
            "felix-1.0-1-aarch64.pkg.tar.zst"
        ],
        "evidence first, the package last, into the task's staging"
    );
    let done = h.pool.completes_of(7);
    assert_eq!(done.len(), 1);
    assert_eq!(done[0]["filename"], "felix-1.0-1-aarch64.pkg.tar.zst");
    assert_eq!(done[0]["version"], "1.0-1");
    assert!(
        h.leases().is_empty() && !h.engine.has(7, GEN) && !h.tdir(7, GEN).exists(),
        "cleaned up"
    );
}

#[test]
fn the_claim_lists_the_leases_with_the_capacity_and_reuses_its_claim_id_after_a_lost_answer() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.pool.answer(Answer::Down);
    d.tick();
    let first = h.pool.last_claim();
    assert_eq!(first["want"], 1);
    assert_eq!(first["capacity"]["units"], 11);
    assert_eq!(first["kinds"], json!(["build", "trial", "audit"]));
    assert_eq!(first["orders"], json!(["drain", "restart", "stop-task"]));
    h.advance(61);
    h.give(community(7, GEN));
    d.tick();
    let retry = h.pool.last_claim();
    assert_eq!(
        retry["claim_id"], first["claim_id"],
        "a retry after a lost answer sends the same claim_id"
    );
    h.ticks(&mut d, 2);
    let next = h.pool.last_claim();
    assert_ne!(
        next["claim_id"], first["claim_id"],
        "a new claim after an answer"
    );
    assert_eq!(next["leases"], json!([{ "task": 7, "gen": GEN }]));
    // Full: claims only with want 0, every 30 s.
    h.units(3);
    let n = h.pool.claim_bodies.lock().unwrap().len();
    h.ticks(&mut d, 10);
    assert_eq!(
        h.pool.claim_bodies.lock().unwrap().len(),
        n + 1,
        "one claim in 30 s"
    );
    assert_eq!(h.pool.last_claim()["want"], 0);
    // No capacity file: want 0, and no capacity sent.
    std::fs::remove_file(&h.capacity).unwrap();
    h.advance(31);
    d.tick();
    assert_eq!(h.pool.last_claim()["want"], 0);
    assert!(h.pool.last_claim().get("capacity").is_none());
}

#[test]
fn a_release_replaces_the_dispatcher_while_a_task_runs_and_the_task_finishes() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    assert!(h.engine.has(7, GEN));
    drop(d); // the old release's dispatcher is gone; its task container is not
    let mut d = h.dispatcher();
    assert_eq!(d.holds(), vec![(7, GEN.to_owned())], "re-adopted");
    assert!(
        h.engine.has(7, GEN) && h.engine.runs.lock().unwrap().len() == 1,
        "not restarted, not touched"
    );
    h.ticks(&mut d, 1);
    assert!(
        h.pool
            .beat_tokens
            .lock()
            .unwrap()
            .iter()
            .any(|(t, tok)| *t == 7 && tok == "omj.secret-of-7"),
        "its heartbeats resume at once"
    );
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.completes_of(7).len(), 1);
}

#[test]
fn a_task_that_ends_during_a_dispatcher_restart_is_completed_from_its_exited_container() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    drop(d);
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    let mut d = h.dispatcher();
    assert_eq!(h.leases()[0].phase, Phase::Finishing);
    h.ticks(&mut d, 1);
    assert_eq!(h.pool.completes_of(7).len(), 1, "completed normally");
    assert!(h.pool.fails_of(7).is_empty());
}

#[test]
fn a_restart_at_every_point_of_a_lease() {
    // Before its container started: prepared again, then started.
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    d.tick(); // claimed, Preparing
    drop(d);
    let mut d = h.dispatcher();
    h.ticks(&mut d, 2);
    assert!(h.engine.has(7, GEN));
    // While it finishes, the pool not answering: a new dispatcher finishes it.
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    h.pool.down.store(true, Ordering::SeqCst);
    h.ticks(&mut d, 1);
    assert_eq!(h.leases()[0].phase, Phase::Finishing);
    assert!(
        h.engine.has(7, GEN),
        "the container stays until it is reported"
    );
    drop(d);
    h.pool.down.store(false, Ordering::SeqCst);
    let mut d = h.dispatcher();
    h.ticks(&mut d, 1);
    assert_eq!(h.pool.completes_of(7).len(), 1);
    assert!(h.leases().is_empty());
}

#[test]
fn a_reboot_mid_task_fails_it_lost_with_its_attempt_back() {
    // The engine came back with the container killed (exit 143, no verdict) …
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    drop(d);
    h.engine.exit(7, GEN, 143, false);
    let mut d = h.dispatcher();
    h.ticks(&mut d, 1);
    let f = h.pool.fails_of(7);
    assert_eq!(f.len(), 1);
    assert_eq!(f[0]["lost"], true, "{}", f[0]);
    // … or without it at all.
    h.give(community(8, GEN2));
    h.advance(31);
    h.ticks(&mut d, 3);
    drop(d);
    h.engine.containers.lock().unwrap().clear();
    let mut d = h.dispatcher();
    h.ticks(&mut d, 1);
    let f = h.pool.fails_of(8);
    assert_eq!(f.len(), 1);
    assert_eq!(f[0]["lost"], true);
    assert!(h.leases().is_empty());
}

#[test]
fn an_oom_kill_fails_oom_even_when_the_script_reported_final() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.leave(
        7,
        GEN,
        &[(
            "verdict.json",
            br#"{"status":4,"final":true,"error":"recipe"}"#.to_vec(),
        )],
        "Killed\n",
    );
    h.engine.exit(7, GEN, 137, true);
    h.ticks(&mut d, 2);
    let f = h.pool.fails_of(7);
    assert_eq!(f.len(), 1);
    assert_eq!(f[0]["oom"], true);
    assert_eq!(
        f[0]["final"], false,
        "the engine's kill, not the script's word"
    );
    assert!(f[0]["error"]
        .as_str()
        .unwrap()
        .contains("memory limit (4 GB"));
    assert_eq!(
        h.pool.staged_of(7),
        ["build.log"],
        "the log is on the record"
    );
}

#[test]
fn a_failed_build_reports_its_verdict_with_its_evidence() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.leave(
        7,
        GEN,
        &[
            ("PKGBUILD", b"pkgname=felix".to_vec()),
            ("verdict.json", br#"{"status":5,"final":true,"needs_native":false,"error":"the gate: namcap: fail"}"#.to_vec()),
        ],
        "==> The gate: FAIL\n",
    );
    h.engine.exit(7, GEN, 5, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.staged_of(7), ["PKGBUILD", "build.log"]);
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(f["final"], true);
    assert_eq!(f["error"], "the gate: namcap: fail");
    assert!(f["log_tail"].as_str().unwrap().contains("The gate: FAIL"));
}

#[test]
fn an_output_outside_the_kinds_list_or_above_its_cap_is_not_uploaded_and_fails_the_task() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.give(task(
        8,
        "build",
        "felix",
        "https://x@v1:PKGBUILD",
        "community",
        json!({}),
        GEN2,
    ));
    h.ticks(&mut d, 4);
    let mut evil = built_ok();
    evil.push(("evil.sh", b"#!/bin/sh".to_vec()));
    h.leave(7, GEN, &evil, "log\n");
    h.engine.exit(7, GEN, 0, false);
    let mut big = built_ok();
    big[1] = ("PKGBUILD", vec![b'#'; (1 << 20) + 1]);
    h.leave(8, GEN2, &big, "log\n");
    h.engine.exit(8, GEN2, 0, false);
    h.ticks(&mut d, 2);
    for id in [7, 8] {
        assert!(h.pool.staged_of(id).is_empty(), "nothing uploaded for {id}");
        assert!(h.pool.completes_of(id).is_empty());
        let f = &h.pool.fails_of(id)[0];
        assert_eq!(f["final"], true);
        assert!(
            f["error"]
                .as_str()
                .unwrap()
                .contains("nothing was uploaded"),
            "{f}"
        );
    }
}

#[test]
fn a_pool_outage_longer_than_a_lease_kills_only_the_expired_leases_containers() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    // Its heartbeats stop being heard; the other lease's are.
    h.pool.beats.lock().unwrap().insert(7, BeatMode::Down);
    h.advance(20 * 60);
    h.ticks(&mut d, 1);
    h.give(task(
        9,
        "audit",
        "felix",
        "",
        "community",
        json!({ "task": 7 }),
        GEN2,
    ));
    h.pool
        .artifacts
        .lock()
        .unwrap()
        .insert((7, "PKGBUILD".into()), b"pkgname=felix".to_vec());
    h.pool
        .artifacts
        .lock()
        .unwrap()
        .insert((7, "build.log".into()), b"log".to_vec());
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(h.engine.has(9, GEN2));
    // The pool stops answering anything.
    h.pool.down.store(true, Ordering::SeqCst);
    h.pool.answer(Answer::Down);
    h.advance(16 * 60); // lease 7: 36 min since its last accepted heartbeat (its claim); lease 9: 16 min
    h.ticks(&mut d, 1);
    assert!(
        !h.engine.has(7, GEN),
        "the expired lease's containers are killed by its own watchdog"
    );
    assert!(h.engine.has(9, GEN2), "the other lease runs on");
    h.ticks(&mut d, 1);
    assert!(
        h.pool.fails_of(7).is_empty() && h.pool.completes_of(7).is_empty(),
        "nothing reported for it"
    );
    assert_eq!(d.holds(), vec![(9, GEN2.to_owned())]);
    assert_eq!(
        h.engine
            .removed
            .lock()
            .unwrap()
            .iter()
            .filter(|(t, _)| *t == 9)
            .count(),
        0
    );
}

#[test]
fn heartbeats_renew_the_token_and_a_stop_kills_and_fails_as_stopped() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.pool
        .beats
        .lock()
        .unwrap()
        .insert(7, BeatMode::Renew("omj.renewed".into()));
    h.advance(301);
    h.ticks(&mut d, 1);
    assert_eq!(
        h.leases()[0].token,
        "omj.renewed",
        "the token moves with the lease"
    );
    h.pool
        .beats
        .lock()
        .unwrap()
        .insert(7, BeatMode::Stop("cancelled".into()));
    h.advance(301);
    h.ticks(&mut d, 2);
    assert!(!h.engine.has(7, GEN), "its containers are killed by label");
    let f = &h.pool.fails_of(7)[0];
    assert!(f["error"]
        .as_str()
        .unwrap()
        .contains("stopped by the pool (cancelled)"));
    assert!(h.leases().is_empty());
    h.advance(31);
    h.ticks(&mut d, 1);
    assert!(
        h.pool.last_claim()["leases"].as_array().unwrap().is_empty(),
        "the claims stop listing it, which ends the fence"
    );
}

#[test]
fn stale_generations_and_strangers_at_readoption() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    drop(d);
    // An older lease's container of the same task, a container of this host with no lease file, another host's, and a lease file that does not read.
    h.engine
        .put(&spec::container_name(7, GEN2), "running", HOST);
    h.engine
        .put(&spec::container_name(12, GEN2), "exited", HOST);
    h.engine
        .put(&spec::container_name(13, GEN2), "running", "h_other");
    h.engine.put("omarchy-build-14", "running", HOST);
    std::fs::write(h.work.join("state/leases/15-g_00000000000000c3.json"), b"{").unwrap();
    h.engine.put(
        &spec::container_name(15, "g_00000000000000c3"),
        "running",
        HOST,
    );
    let d = h.dispatcher();
    assert_eq!(d.holds(), vec![(7, GEN.to_owned())]);
    assert!(h.engine.has(7, GEN), "this lease's container is adopted");
    assert!(!h.engine.has(7, GEN2), "the older generation's goes");
    assert!(
        !h.engine.has(12, GEN2),
        "a container without a lease file goes"
    );
    assert!(
        !h.engine.has(15, "g_00000000000000c3"),
        "an unreadable lease file's container goes"
    );
    assert!(!h
        .work
        .join("state/leases/15-g_00000000000000c3.json")
        .exists());
    assert!(
        h.engine.has(13, GEN2),
        "another host's container is not this dispatcher's"
    );
    assert!(
        h.engine
            .containers
            .lock()
            .unwrap()
            .contains_key("omarchy-build-14"),
        "a legacy worker's container is not touched"
    );
}

#[test]
fn the_disk_watcher_kills_the_youngest_build_lost_and_stops_claiming() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.give(task(
        8,
        "build",
        "felix",
        "https://x@v1:PKGBUILD",
        "community",
        json!({}),
        GEN2,
    ));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(h.engine.has(7, GEN) && h.engine.has(8, GEN2));
    *h.free.lock().unwrap() = Some(9); // below the signed floor of 10 GB
    h.ticks(&mut d, 1);
    assert!(!h.engine.has(8, GEN2), "the youngest build is killed");
    assert!(h.engine.has(7, GEN), "one at a time");
    h.ticks(&mut d, 1);
    let f = &h.pool.fails_of(8)[0];
    assert_eq!(f["lost"], true);
    assert!(f["error"].as_str().unwrap().contains("disk watcher"));
    h.advance(31);
    h.ticks(&mut d, 1);
    assert_eq!(
        h.pool.last_claim()["want"],
        0,
        "no claim for work while the disk is low"
    );
    *h.free.lock().unwrap() = Some(400);
    h.advance(31);
    h.ticks(&mut d, 1);
    assert_eq!(
        h.pool.last_claim()["want"],
        1,
        "claiming again once the space is back"
    );
}

#[test]
fn a_build_starts_only_with_its_budget_plus_the_floor_free() {
    let h = H::new();
    *h.free.lock().unwrap() = Some(25); // the floor is 10, the build's budget 20
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    assert!(h.engine.runs.lock().unwrap().is_empty());
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(f["lost"], true);
    assert!(f["error"].as_str().unwrap().contains("not started"));
}

#[test]
fn a_value_outside_the_grammar_fails_the_task_before_docker() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(task(
        7,
        "build",
        "Felix;reboot",
        "x",
        "community",
        json!({}),
        GEN,
    ));
    let mut bad_arch = community(8, GEN2);
    bad_arch["task"]["arch"] = json!("riscv64");
    h.give(bad_arch);
    let mut no_gen = community(9, GEN2);
    no_gen["task"]["lease_gen"] = Value::Null;
    h.give(no_gen);
    h.ticks(&mut d, 6);
    assert!(h.engine.runs.lock().unwrap().is_empty());
    assert_eq!(h.pool.fails_of(7)[0]["final"], true);
    assert_eq!(h.pool.fails_of(8)[0]["final"], true);
    assert_eq!(h.pool.fails_of(9).len(), 1);
    assert!(h.leases().is_empty());
}

#[test]
fn a_build_image_that_is_not_a_digest_fails_the_task_before_docker() {
    let h = H::new();
    let pool: Arc<dyn Pool> = h.pool.clone();
    let ctx = Ctx {
        pool,
        work_root: h.work.clone(),
        pool_url: "https://pool.example".into(),
        checkout: Some(h.checkout.clone()),
        constants: Constants::signed(),
    };
    let mut d = Dispatcher::new(
        ctx,
        h.engine.clone(),
        Box::new(FakeProbes {
            now: Arc::clone(&h.now),
            work: Arc::clone(&h.free),
        }),
        Timing::default(),
        HOST.into(),
        h.capacity.clone(),
        Images {
            aarch64: "docker.io/library/archlinux:base-devel".into(),
            x86_64: String::new(),
        },
        None,
        true,
    )
    .unwrap();
    d.readopt().unwrap();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    assert!(h.engine.runs.lock().unwrap().is_empty());
    assert!(h.pool.fails_of(7)[0]["error"]
        .as_str()
        .unwrap()
        .contains("not an image by digest"));
}

#[test]
fn a_review_rebuild_learns_from_staged_evidence_and_stages_for_a_maintainer() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.pool
        .artifacts
        .lock()
        .unwrap()
        .insert((5, "PKGBUILD".into()), b"pkgname=felix".to_vec());
    h.pool
        .artifacts
        .lock()
        .unwrap()
        .insert((5, "build.log".into()), b"contributor's log".to_vec());
    h.give(task(
        7,
        "build",
        "felix",
        "review:5",
        "project",
        json!({ "review": 5, "project": "https://felix.example" }),
        GEN,
    ));
    h.ticks(&mut d, 3);
    let input = h.tdir(7, GEN).join("in");
    assert_eq!(
        std::fs::read(input.join("artifacts/5/PKGBUILD")).unwrap(),
        b"pkgname=felix"
    );
    assert!(
        !input.join("artifacts/5/audit.md").exists(),
        "a missing artifact is left out"
    );
    let meta = std::fs::read_to_string(input.join("meta.sh")).unwrap();
    assert!(meta.contains("review_url='https://felix.example'"));
    let args = h.engine.args(7, GEN).join(" ");
    assert!(
        args.contains("ANTHROPIC_BASE_URL=http://agent:8790"),
        "a model kind talks to its agent sidecar"
    );
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert!(h
        .pool
        .staged_of(7)
        .contains(&"felix-1.0-1-aarch64.pkg.tar.zst".to_owned()));
    let done = &h.pool.completes_of(7)[0];
    assert_eq!(done["result"]["review"], 5);
    assert!(
        h.pool.published.lock().unwrap().is_empty(),
        "staged, never published"
    );
}

#[test]
fn the_projects_recipe_on_main_is_published_into_edge_with_both_arches_rendered() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(task(
        7,
        "build",
        "felix",
        "0123abcd",
        "project",
        json!({}),
        GEN,
    ));
    h.ticks(&mut d, 3);
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(
        *h.pool.published.lock().unwrap(),
        vec![("edge".to_owned(), "aarch64".to_owned(), 1)]
    );
    assert!(h.pool.staged_of(7).is_empty());
    assert_eq!(
        h.pool.completes_of(7)[0]["result"]["rendered"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn an_audit_attaches_its_report_to_the_staged_build() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.pool
        .artifacts
        .lock()
        .unwrap()
        .insert((5, "PKGBUILD".into()), b"pkgname=felix".to_vec());
    h.pool
        .artifacts
        .lock()
        .unwrap()
        .insert((5, "build.log".into()), b"log".to_vec());
    h.give(task(
        9,
        "audit",
        "felix",
        "",
        "community",
        json!({ "task": 5 }),
        GEN,
    ));
    h.ticks(&mut d, 3);
    let input = h.tdir(9, GEN).join("in");
    assert!(
        input.join("artifacts/5/PKGBUILD").is_file()
            && input.join("artifacts/5/build.log").is_file()
    );
    assert!(h
        .engine
        .args(9, GEN)
        .join(" ")
        .contains("--cpus 1 --memory 2g"));
    h.leave(
        9,
        GEN,
        &[
            (
                "audit.json",
                br#"{"verdict":"ok","summary":"fine","findings":[],"model":"m"}"#.to_vec(),
            ),
            ("audit.md", b"# fine".to_vec()),
            ("verdict.json", br#"{"status":0}"#.to_vec()),
        ],
        "",
    );
    h.engine.exit(9, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.staged_of(5), ["audit.json", "audit.md"]);
    assert!(h.pool.completes_of(9)[0]["summary"]
        .as_str()
        .unwrap()
        .starts_with("ok: fine"));
    // An audit whose staged build has no PKGBUILD fails before any container.
    h.give(task(
        10,
        "audit",
        "felix",
        "",
        "community",
        json!({ "task": 6 }),
        GEN2,
    ));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(!h.engine.has(10, GEN2));
    assert!(h.pool.fails_of(10)[0]["error"]
        .as_str()
        .unwrap()
        .contains("no PKGBUILD"));
}

#[test]
fn a_community_build_into_a_full_staging_fails_at_once() {
    let h = H::new();
    let mut d = h.dispatcher();
    let mut t = community(7, GEN);
    t["staging"] = json!({ "bytes": 100, "quota_bytes": 100 });
    h.give(t);
    h.ticks(&mut d, 3);
    assert!(h.engine.runs.lock().unwrap().is_empty());
    assert_eq!(h.pool.fails_of(7)[0]["final"], true);
}

#[test]
fn an_upload_refused_for_its_quota_fails_the_build_final() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    *h.pool.refuse_uploads.lock().unwrap() = Some(413);
    h.ticks(&mut d, 2);
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(f["final"], true);
    assert!(f["error"].as_str().unwrap().contains("staging"));
}

#[test]
fn orders_restart_exits_75_and_a_young_dispatcher_refuses() {
    let h = H::new();
    let mut d = h.dispatcher();
    let order = |id: &str, kind: &str| json!({ "task": null, "orders": [{ "id": id, "kind": kind, "reason": "test", "issued_by": "maintainer" }] });
    let id1 = format!("wo_{}", "1".repeat(32));
    let id2 = format!("wo_{}", "2".repeat(32));
    let id3 = format!("wo_{}", "3".repeat(32));
    h.give(order(&id1, "restart"));
    d.tick();
    assert_eq!(d.exit, None);
    assert_eq!(h.pool.answers.lock().unwrap()[0].1["code"], "too-young");
    h.advance(121);
    h.give(order(&id2, "recheck-agent"));
    d.tick();
    assert_eq!(
        h.pool.answers.lock().unwrap()[1].1["outcome"],
        "refused",
        "no probe sidecar before the agent sidecars issue"
    );
    h.advance(3);
    h.give(order(&id3, "restart"));
    d.tick();
    assert_eq!(d.exit, Some(75));
    assert_eq!(h.pool.answers.lock().unwrap()[2].1["outcome"], "accepted");
}

#[test]
fn the_loop_watchdog_exits_75_and_touches_nothing_else() {
    let progress = Arc::new(AtomicU64::new(100));
    let now = Arc::new(AtomicU64::new(100));
    let code = Arc::new(Mutex::new(None));
    let (n, c) = (Arc::clone(&now), Arc::clone(&code));
    super::loop_watchdog(
        Arc::clone(&progress),
        Duration::from_secs(900),
        Duration::from_millis(10),
        move || n.load(Ordering::SeqCst),
        move |x| *c.lock().unwrap() = Some(x),
    );
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(*code.lock().unwrap(), None, "progress is recent");
    now.store(100 + 901, Ordering::SeqCst);
    for _ in 0..100 {
        if code.lock().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(*code.lock().unwrap(), Some(75));
}

#[test]
fn ready_answers_only_after_readoption_and_leases_show_no_token() {
    let snap = Arc::new(Mutex::new(super::Snapshot::default()));
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    super::serve(l, Arc::clone(&snap));
    let get = |path: &str| {
        use std::io::{Read, Write};
        let mut c = std::net::TcpStream::connect(addr).unwrap();
        c.write_all(format!("GET {path} HTTP/1.1\r\nhost: x\r\n\r\n").as_bytes())
            .unwrap();
        let mut s = String::new();
        c.read_to_string(&mut s).unwrap();
        s
    };
    assert!(get("/ready").starts_with("HTTP/1.1 503"));
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    {
        let mut s = snap.lock().unwrap();
        s.ready = true;
        s.leases = d.snapshot();
    }
    assert!(get("/ready").starts_with("HTTP/1.1 200"));
    let leases = get("/leases");
    assert!(
        leases.contains("\"task\":7") && !leases.contains("omj."),
        "{leases}"
    );
}

#[test]
fn the_dispatcher_refuses_a_signing_key() {
    let env = |k: &str, v: &str| {
        vec![
            ("PATH".to_owned(), "/bin".to_owned()),
            (k.to_owned(), v.to_owned()),
        ]
    };
    assert!(super::refuse_signing_key(env("OMARCHY_WORKER_TOKEN", "omw_x")).is_ok());
    for (k, v) in [
        ("SIGNING_KEY", "x"),
        ("OMARCHY_GPG_KEYID", "ABCDEF"),
        ("SOMETHING", "-----BEGIN PGP PRIVATE KEY BLOCK-----\n..."),
    ] {
        let e = super::refuse_signing_key(env(k, v))
            .unwrap_err()
            .to_string();
        assert!(e.contains(k) && e.contains("signing key"), "{e}");
    }
}

#[test]
fn a_trial_publishes_the_lab_then_its_helper_installs_from_it() {
    let h = H::new();
    // The checkout's trial.sh in its staging mode: what the dispatcher calls before the helper.
    std::fs::create_dir_all(h.checkout.join("tests")).unwrap();
    std::fs::write(
        h.checkout.join("tests/trial.sh"),
        "#!/bin/bash\nset -e\n[[ -n \"$TRIAL_STAGE\" && -z \"${OMARCHY_TOKEN:-}\" ]] || exit 9\nprintf '%s\\n' \"${@:3}\" > \"$TRIAL_STAGE/packages.txt\"\necho check > \"$TRIAL_STAGE/check.sh\"\n",
    )
    .unwrap();
    std::fs::write(
        h.checkout.join("tests/fetch-keyrings.sh"),
        "#!/bin/bash\ntouch \"$1/archlinux.gpg\"\n",
    )
    .unwrap();
    let mut d = h.dispatcher();
    h.pool.artifacts.lock().unwrap().insert(
        (5, "felix-1.0-1-aarch64.pkg.tar.zst".into()),
        package("felix"),
    );
    h.give(task(
        11,
        "trial",
        "felix",
        "",
        "project",
        json!({ "task": 5, "files": ["felix-1.0-1-aarch64.pkg.tar.zst"] }),
        GEN,
    ));
    h.ticks(&mut d, 3);
    assert_eq!(
        *h.pool.published.lock().unwrap(),
        vec![("lab".to_owned(), "aarch64".to_owned(), 1)]
    );
    let input = h.tdir(11, GEN).join("in");
    assert_eq!(
        std::fs::read_to_string(input.join("packages.txt")).unwrap(),
        "felix\n"
    );
    assert!(
        !h.tdir(11, GEN).join("trusted").exists(),
        "the trusted steps' files are gone before the helper starts"
    );
    assert!(
        !h.engine.args(11, GEN).join(" ").contains("ANTHROPIC"),
        "the helper has no agent"
    );
    h.leave(11, GEN, &[], "== pacman -Sy\nTRIAL=ok\n");
    h.engine.exit(11, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.staged_of(5), ["trial.log"]);
    let done = &h.pool.completes_of(11)[0];
    assert_eq!(done["result"]["verdict"], "ok");
    assert_eq!(h.pool.events.lock().unwrap()[0]["status"], "ok");
}

#[test]
fn sigterm_stops_the_claims() {
    let h = H::new();
    let mut d = h.dispatcher();
    d.terminating.store(true, Ordering::SeqCst);
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    assert!(h.pool.claim_bodies.lock().unwrap().is_empty());
}

#[test]
fn an_engine_that_does_not_answer_is_not_a_lost_container() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.engine.deaf.store(true, Ordering::SeqCst);
    h.ticks(&mut d, 5);
    assert!(
        h.engine.has(7, GEN) && h.pool.fails_of(7).is_empty(),
        "nothing is killed or reported while the engine is busy"
    );
    assert!(
        h.dispatcher_readopt_fails(),
        "and a new dispatcher is not ready until the engine answers"
    );
    h.engine.deaf.store(false, Ordering::SeqCst);
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.completes_of(7).len(), 1);
}

#[test]
fn a_log_that_is_a_link_is_never_read_even_when_the_engine_killed_the_task() {
    let h = H::new();
    let mut d = h.dispatcher();
    let secret = h.work.join("dispatcher-secret");
    std::fs::write(&secret, "omj.secret-of-the-dispatcher").unwrap();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    std::os::unix::fs::symlink(&secret, h.tdir(7, GEN).join("log/task.log")).unwrap();
    h.engine.exit(7, GEN, 137, true);
    h.ticks(&mut d, 2);
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(f["oom"], true);
    assert!(!f.to_string().contains("secret-of-the-dispatcher"), "{f}");
    assert!(h.pool.staged_of(7).is_empty(), "the link is not uploaded");
}
