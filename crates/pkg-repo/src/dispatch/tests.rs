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
use super::{jobs, shim, Dispatcher, Images, Net, Probes, Timing, DISK_HOLD, KINDS, MEM_RAMP};
use crate::stop::Beat;
use crate::RepoError;

const GEN: &str = "g_00000000000000a1";
const GEN2: &str = "g_00000000000000b2";
const HOST: &str = "h_test";
const IMAGE: &str = "docker.io/library/archlinux@sha256:51dd3d24f7fba779e7c471caeee7804c50e8c134ad948e19685a1c83a42facc3";
const WORKER: &str = "ghcr.io/firemanxbr/omarchy-worker@sha256:2222222222222222222222222222222222222222222222222222222222222222";

/// The networks and sidecars of a host with an agent key.
fn net() -> Net {
    Net {
        worker_image: WORKER.into(),
        secrets_dir: Some(PathBuf::from("/srv/omarchy/secrets")),
        ..Net::default()
    }
}

// ---------- the fake engine ----------

/// A container: its state, its host label, the arguments it was started with (none for one put there by hand).
type Container = (State, String, Vec<String>);

#[derive(Default)]
struct FakeEngine {
    containers: Mutex<BTreeMap<String, Container>>,
    /// Task containers started (`run -d`).
    runs: Mutex<Vec<Vec<String>>>,
    /// Every call, in order.
    calls: Mutex<Vec<Vec<String>>>,
    /// Networks: name → (host label, the containers attached).
    networks: Mutex<BTreeMap<String, (String, Vec<String>)>>,
    removed: Mutex<Vec<(u64, String)>>,
    /// What the probe's one-shot agent prints; an answering agent when unset.
    probe_says: Mutex<Option<String>>,
    /// `inspect` gets no answer (a busy daemon).
    deaf: AtomicBool,
    /// Kills and removals do not take (a daemon that does not answer them).
    stuck: AtomicBool,
    /// The engine refuses to start the container whose name ends with this.
    refuse: Mutex<Option<String>>,
    /// Each network's `--subnet`: a second network on a /28 still in use is refused, as the engines do.
    subnets: Mutex<BTreeMap<String, String>>,
    /// A lease's teardown leaves its network behind (a `network rm` past its deadline).
    keep_network: AtomicBool,
}

fn label_of<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter().find_map(|a| a.strip_prefix(&format!("{key}=")))
}

fn value_of<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
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
    fn has_name(&self, name: &str) -> bool {
        self.containers.lock().unwrap().contains_key(name)
    }
    fn has_network(&self, name: &str) -> bool {
        self.networks.lock().unwrap().contains_key(name)
    }
    fn args(&self, id: u64, gen: &str) -> Vec<String> {
        self.containers.lock().unwrap()[&spec::container_name(id, gen)]
            .2
            .clone()
    }
    fn args_of(&self, name: &str) -> Vec<String> {
        self.containers.lock().unwrap()[name].2.clone()
    }
    /// The networks a container is attached to.
    fn attached(&self, name: &str) -> Vec<String> {
        self.networks
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, (_, on))| on.iter().any(|c| c == name))
            .map(|(n, _)| n.clone())
            .collect()
    }
    fn add(&self, args: &[String], status: &str) -> Result<(), String> {
        let name = value_of(args, "--name").unwrap().to_owned();
        if self
            .refuse
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|r| name.ends_with(r.as_str()))
        {
            return Err(format!("the engine refused {name}"));
        }
        let host = label_of(args, HOST_LABEL).unwrap_or_default().to_owned();
        let mut c = self.containers.lock().unwrap();
        if c.contains_key(&name) {
            return Err(format!("the name {name} is in use"));
        }
        if let Some(net) = value_of(args, "--network") {
            let mut n = self.networks.lock().unwrap();
            let Some(on) = n.get_mut(net) else {
                return Err(format!("network {net} not found"));
            };
            on.1.push(name.clone());
        }
        c.insert(
            name,
            (
                State {
                    status: status.into(),
                    ..State::default()
                },
                host,
                args.to_vec(),
            ),
        );
        Ok(())
    }
}

impl Engine for FakeEngine {
    fn run(&self, args: &[String]) -> Result<(), String> {
        self.calls.lock().unwrap().push(args.to_vec());
        let words: Vec<&str> = args.iter().map(String::as_str).collect();
        match words.as_slice() {
            ["network", "inspect", name] => {
                if self.has_network(name) {
                    Ok(())
                } else {
                    Err(format!("network {name} not found"))
                }
            }
            ["network", "create", .., name] => {
                let mut n = self.networks.lock().unwrap();
                if n.contains_key(*name) {
                    return Err(format!("network {name} already exists"));
                }
                let mut subnets = self.subnets.lock().unwrap();
                if let Some(sub) = value_of(args, "--subnet") {
                    if subnets
                        .iter()
                        .any(|(other, s)| s == sub && n.contains_key(other))
                    {
                        return Err(format!(
                            "Pool overlaps with other one on this address space ({sub})"
                        ));
                    }
                    subnets.insert((*name).to_owned(), sub.to_owned());
                }
                let host = label_of(args, HOST_LABEL).unwrap_or_default().to_owned();
                n.insert((*name).to_owned(), (host, Vec::new()));
                Ok(())
            }
            ["network", "connect", "--ip", _, net, who] => {
                if !self.has_name(who) {
                    return Err(format!("no container {who}"));
                }
                let mut n = self.networks.lock().unwrap();
                let on = n
                    .get_mut(*net)
                    .ok_or_else(|| format!("network {net} not found"))?;
                on.1.push((*who).to_owned());
                Ok(())
            }
            ["create", ..] => self.add(args, "created"),
            ["start", who] => {
                let mut c = self.containers.lock().unwrap();
                let e = c
                    .get_mut(*who)
                    .ok_or_else(|| format!("no container {who}"))?;
                e.0.status = "running".into();
                Ok(())
            }
            ["run", "-d", ..] => {
                self.add(args, "running")?;
                self.runs.lock().unwrap().push(args.to_vec());
                Ok(())
            }
            other => panic!("a call the fake engine does not know: {other:?}"),
        }
    }
    fn output(&self, args: &[String]) -> Result<(String, String), String> {
        self.calls.lock().unwrap().push(args.to_vec());
        assert_eq!(args[..2], ["run", "--rm"], "the probe's one-shot agent");
        let net = value_of(args, "--network").unwrap();
        assert!(self.has_network(net), "the probe runs on its own network");
        Ok((
            self.probe_says.lock().unwrap().clone().unwrap_or_else(|| {
                r#"{"ok": true, "provider": "anthropic", "model": "claude-sonnet-5", "agent": "anthropic/claude-sonnet-5", "ms": 40}"#.into()
            }),
            String::new(),
        ))
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
    fn networks(&self, host: &str) -> Result<Vec<String>, String> {
        Ok(self
            .networks
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, n)| n.0 == host)
            .map(|(n, _)| n.clone())
            .collect())
    }
    fn remove_lease(&self, task: u64, gen: &str) {
        if self.stuck.load(Ordering::SeqCst) {
            return;
        }
        // By its labels: the containers this lease started — its task container and its sidecars (a stranger
        // without them is not found this way) — then its network.
        let (t, g) = (task.to_string(), gen.to_owned());
        let mut c = self.containers.lock().unwrap();
        let gone: Vec<String> = c
            .iter()
            .filter(|(_, x)| {
                label_of(&x.2, crate::stop::TASK_LABEL) == Some(t.as_str())
                    && label_of(&x.2, spec::GEN_LABEL) == Some(g.as_str())
            })
            .map(|(n, _)| n.clone())
            .collect();
        let mut n = self.networks.lock().unwrap();
        for name in &gone {
            c.remove(name);
            for on in n.values_mut() {
                on.1.retain(|x| x != name);
            }
        }
        let net = spec::container_name(task, gen);
        if n.get(&net).is_some_and(|x| x.1.is_empty()) && !self.keep_network.load(Ordering::SeqCst)
        {
            n.remove(&net);
        }
        self.removed.lock().unwrap().push((task, gen.to_owned()));
    }
    fn remove_name(&self, name: &str) {
        if self.stuck.load(Ordering::SeqCst) {
            return;
        }
        self.containers.lock().unwrap().remove(name);
        for on in self.networks.lock().unwrap().values_mut() {
            on.1.retain(|x| x != name);
        }
    }
    fn remove_network(&self, name: &str) {
        let mut n = self.networks.lock().unwrap();
        if n.get(name).is_some_and(|x| x.1.is_empty()) {
            n.remove(name);
        }
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
    /// Each heartbeat takes this long (a pool that holds the connection open).
    slow_beat: Mutex<Duration>,
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
        std::thread::sleep(*self.slow_beat.lock().unwrap());
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

// ---------- pool jobs' children (#340) ----------

/// What a pool job's child runs, by its task's id: a shell with its job directory in `JOB_DIR`;
/// one not set writes a render's result. It also hands the child the host's worker token and a
/// job token in its environment, which the dispatcher must take out.
#[derive(Default, Clone)]
struct FakeLaunch(Arc<Mutex<HashMap<u64, String>>>);

/// A job that returned what a render returns, and wrote down its environment.
const JOB_DONE: &str = r#"env > "$JOB_DIR/env.txt"; printf '%s' '{"ok":true,"summary":"edge/x86_64 rendered: omarchy-core-edge","result":{"repos":["omarchy-core-edge"]},"duration_ms":5}' > "$JOB_DIR/result.json""#;

impl FakeLaunch {
    fn set(&self, id: u64, script: &str) {
        self.0.lock().unwrap().insert(id, script.to_owned());
    }
}

impl jobs::Launch for FakeLaunch {
    fn command(&self, dir: &Path) -> std::process::Command {
        let id: u64 = dir
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.split('-').next())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        let script = self
            .0
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .unwrap_or_else(|| JOB_DONE.to_owned());
        let mut c = std::process::Command::new("sh");
        c.arg("-c")
            .arg(script)
            .env("JOB_DIR", dir)
            .env("OMARCHY_WORKER_TOKEN", "omw_host-secret")
            .env("OMARCHY_TOKEN", "omj.stale");
        c
    }
}

// ---------- the clock and the host ----------

struct FakeProbes {
    now: Arc<AtomicU64>,
    work: Arc<Mutex<Option<u64>>>,
    mem: Arc<Mutex<Option<u64>>>,
}

impl Probes for FakeProbes {
    fn now(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn work_free_gb(&self) -> Option<u64> {
        *self.work.lock().unwrap()
    }
    fn mem_available_gb(&self) -> Option<u64> {
        *self.mem.lock().unwrap()
    }
}

// ---------- the harness ----------

struct H {
    _t: tempfile::TempDir,
    /// What each pool job's child runs (#340).
    launch: FakeLaunch,
    work: PathBuf,
    checkout: PathBuf,
    capacity: PathBuf,
    engine: Arc<FakeEngine>,
    pool: Arc<FakePool>,
    now: Arc<AtomicU64>,
    free: Arc<Mutex<Option<u64>>>,
    /// `MemAvailable`, in GB: none (no `/proc/meminfo`) unless a test sets it.
    mem: Arc<Mutex<Option<u64>>>,
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
        // The images the release pins: what a pool job's helpers may run (#340).
        std::fs::create_dir_all(checkout.join("tests")).unwrap();
        std::fs::write(
            checkout.join("tests/images.env"),
            format!("ARCHLINUX_BASE=\"{IMAGE}\"\n"),
        )
        .unwrap();
        let h = Self {
            launch: FakeLaunch::default(),
            capacity: root.join("capacity.json"),
            work,
            checkout,
            _t: t,
            engine: Arc::new(FakeEngine::default()),
            pool: Arc::new(FakePool::default()),
            now: Arc::new(AtomicU64::new(1_000_000)),
            free: Arc::new(Mutex::new(Some(500))),
            mem: Arc::new(Mutex::new(None)),
        };
        h.units(11);
        h
    }

    fn units(&self, units: u32) {
        self.capacity_file(units, 150, "2026-10-01T00:00:00Z");
    }

    /// The agent's file: its units, its free engine disk, when it probed.
    fn capacity_file(&self, units: u32, engine: u64, at: &str) {
        std::fs::write(&self.capacity, json!({"schema":2,"at":at,"cpus":12,"mem_gb":32,"page_kb":16,"disk_free_gb":{"work":200,"engine":engine},"units":units,"job_reserved":1,"agent_slots":1,"lanes":[{"arch":"aarch64","mode":"native"}],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}).to_string()).unwrap();
    }

    /// A dispatcher on this host: a new one is a restart (the engine and the lease files stay).
    fn dispatcher(&self) -> Dispatcher {
        self.dispatcher_with(
            Timing::default(),
            Images {
                aarch64: IMAGE.into(),
                x86_64: IMAGE.into(),
            },
        )
    }

    fn dispatcher_with(&self, timing: Timing, images: Images) -> Dispatcher {
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
                mem: Arc::clone(&self.mem),
            }),
            timing,
            HOST.into(),
            self.capacity.clone(),
            images,
            None,
            true,
        )
        .unwrap();
        d.net = net();
        d.jobs.launch = Arc::new(self.launch.clone());
        d.jobs.engine = PathBuf::from("/usr/bin/docker");
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
                mem: Arc::clone(&self.mem),
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
        all.contains("--cpus 1.900") && all.contains("--memory 4032m"),
        "its units' share, less its egress sidecar's: {all}"
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
    assert_eq!(
        first["kinds"],
        json!([
            "build", "trial", "audit", "sync", "render", "promote", "rollback", "security", "gc",
            "verify", "relayout", "enqueue", "publish", "health"
        ]),
        "its tasks, and the pool jobs while their unit is free (#340)"
    );
    assert_eq!(
        first["orders"],
        json!([
            "drain",
            "recheck-agent",
            "restart",
            "restart-agent",
            "stop-task"
        ])
    );
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
    // Full, the pool jobs' unit too: claims only with want 0, every 30 s.
    h.units(2);
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

/// A lease generation for the n-th of several tasks.
fn gen_of(n: u64) -> String {
    format!("g_{:016x}", 0xc000 + n)
}

/// A claim's kinds while the pool jobs' unit is free (#340): these tasks, and the pool's kinds.
fn with_jobs(tasks: &[&str]) -> Value {
    json!(tasks
        .iter()
        .chain(jobs::POOL_KINDS.iter())
        .copied()
        .collect::<Vec<_>>())
}

#[test]
fn a_host_takes_as_many_tasks_as_its_units_hold_one_container_each_then_wants_only_a_pool_job() {
    // The pool hands one task per claim (D29); the dispatcher claims again at the next tick while units
    // are free, starts each lease in its own container at once (no queue on the host), and once its 11
    // units hold five builds and the pool jobs' unit is all that is left, claims every 30 s for a pool
    // job only (#340): no task unit offered, the pool's kinds listed.
    let h = H::new();
    let mut d = h.dispatcher();
    for n in 0..6 {
        h.give(community(100 + n, &gen_of(n)));
    }
    h.ticks(&mut d, 12);
    let bodies = h.pool.claim_bodies.lock().unwrap().clone();
    let wants: Vec<u64> = bodies.iter().map(|b| b["want"].as_u64().unwrap()).collect();
    assert_eq!(&wants[..6], &[1, 1, 1, 1, 1, 1], "{wants:?}");
    assert!(
        bodies[5]["kinds"]
            .as_array()
            .unwrap()
            .contains(&json!("sync")),
        "the sixth claim wants the pool jobs' unit"
    );
    assert_eq!(h.leases().len(), 5);
    for n in 0..5 {
        assert!(
            h.engine.has(100 + n, &gen_of(n)),
            "task {} runs in its own container",
            100 + n
        );
    }
    assert_eq!(h.engine.runs.lock().unwrap().len(), 5);
    // The sixth was handed to a claim that offered no task unit: given back, never started.
    assert_eq!(h.pool.fails_of(105)[0]["lost"], true);
    // Every task unit held: one claim in 30 s, listing all five, for the pool jobs' unit only.
    let n = h.pool.claim_bodies.lock().unwrap().len();
    h.ticks(&mut d, 10);
    assert_eq!(h.pool.claim_bodies.lock().unwrap().len(), n + 1);
    assert_eq!(h.pool.last_claim()["want"], 1);
    assert!(h.pool.last_claim().get("offer").is_none());
    assert_eq!(h.pool.last_claim()["leases"].as_array().unwrap().len(), 5);
    // One ends: a build's units are free again, and the next claim wants a task.
    h.leave(100, &gen_of(0), &built_ok(), "==> Finished making: felix\n");
    h.engine.exit(100, &gen_of(0), 0, false);
    h.advance(31);
    h.ticks(&mut d, 3);
    assert_eq!(h.leases().len(), 4);
    assert_eq!(h.pool.last_claim()["want"], 1);
}

#[test]
fn a_memory_check_that_refuses_claims_only_what_still_fits_or_nothing() {
    let h = H::new();
    let mut d = h.dispatcher();
    // Another workload holds the machine: less than a unit's 2 GB available — nothing this round.
    *h.mem.lock().unwrap() = Some(1);
    d.tick();
    let c = h.pool.last_claim();
    assert_eq!(c["want"], 0);
    assert_eq!(
        c["capacity"]["units"], 11,
        "want 0 changes nothing of the capacity"
    );
    assert!(c.get("offer").is_none());
    // 9 GB: four units of the ten free — the claim offers those only (`offer`), and its capacity still
    // says the host's 11 units: the pool counts the host by them, and hands nothing above the offer.
    *h.mem.lock().unwrap() = Some(9);
    h.advance(31);
    let mut big = community(7, GEN);
    big["task"]["units"] = json!(6);
    h.give(big);
    d.tick();
    let c = h.pool.last_claim();
    assert_eq!(
        (
            c["want"].clone(),
            c["offer"].clone(),
            c["capacity"]["units"].clone()
        ),
        (json!(1), json!(4), json!(11))
    );
    // A task above what it offered (the pool's mistake) is given back, never started.
    h.ticks(&mut d, 2);
    assert!(h.engine.runs.lock().unwrap().is_empty());
    assert_eq!(h.pool.fails_of(7)[0]["lost"], true);
    // A task that fits what it offered runs.
    h.advance(31);
    h.give(community(8, GEN2));
    h.ticks(&mut d, 3);
    assert!(h.engine.has(8, GEN2));
    // The memory back: the largest task it could receive fits (16 GB, beside the 4 GB the build just
    // started still owes), every free unit is offered again — no `offer` at all.
    *h.mem.lock().unwrap() = Some(64);
    h.advance(31);
    h.ticks(&mut d, 1);
    let c = h.pool.last_claim();
    assert_eq!(
        (c["want"].clone(), c["capacity"]["units"].clone()),
        (json!(1), json!(11))
    );
    assert!(c.get("offer").is_none());
}

#[test]
fn claims_that_follow_each_other_at_once_never_offer_the_same_memory_twice() {
    // MemAvailable holds at 9 GB: the containers just started have not grown yet. Each lease's share
    // (2 GB a unit) counts as promised from its claim until MEM_RAMP after its start, so the burst of
    // claims after each task takes 4 units (8 GB) in all, never the host's ten free units.
    let h = H::new();
    let mut d = h.dispatcher();
    *h.mem.lock().unwrap() = Some(9);
    for n in 0..4 {
        h.give(community(300 + n, &gen_of(n)));
    }
    h.ticks(&mut d, 8);
    let offers: Vec<Value> = h
        .pool
        .claim_bodies
        .lock()
        .unwrap()
        .iter()
        .map(|b| json!([b["want"], b["offer"]]))
        .collect();
    assert_eq!(
        &offers[..3],
        &[json!([1, 4]), json!([1, 2]), json!([0, null])],
        "{offers:?}"
    );
    let held: u32 = h.leases().iter().map(|l| l.units).sum();
    assert_eq!(held, 4, "8 GB of memory limits against 9 GB available");
    // The third was handed to a claim that offered nothing: given back, never started.
    assert_eq!(h.pool.fails_of(302)[0]["lost"], true);
    assert_eq!(h.engine.runs.lock().unwrap().len(), 2);
    // Past the ramp, MemAvailable holds what the containers use (4 GB of their 8): what is left is offered.
    h.advance(MEM_RAMP + 31);
    *h.mem.lock().unwrap() = Some(5);
    h.ticks(&mut d, 1);
    let c = h.pool.last_claim();
    assert_eq!(
        (c["want"].clone(), c["offer"].clone()),
        (json!(1), json!(2))
    );
}

#[test]
fn the_claim_says_the_work_root_as_measured_now_when_it_holds_less_than_the_agents_probe() {
    let h = H::new();
    let mut d = h.dispatcher();
    // The agent's file says 200 GB on the work root; the dispatcher measures 150 now (builds write there).
    *h.free.lock().unwrap() = Some(150);
    d.tick();
    let c = h.pool.last_claim();
    assert_eq!(c["capacity"]["disk_free_gb"]["work"], 150);
    assert_eq!(
        c["capacity"]["disk_free_gb"]["engine"], 150,
        "the engine's is the agent's"
    );
    // More now than the probe said: the probe's value stands, never a higher one.
    *h.free.lock().unwrap() = Some(500);
    h.advance(31);
    d.tick();
    assert_eq!(h.pool.last_claim()["capacity"]["disk_free_gb"]["work"], 200);
}

#[test]
fn fewer_units_than_leases_claims_nothing_until_they_fit_and_kills_nothing() {
    let h = H::new();
    let mut d = h.dispatcher();
    for n in 0..3 {
        h.give(community(200 + n, &gen_of(n)));
    }
    h.ticks(&mut d, 8);
    assert_eq!(h.leases().len(), 3);
    // The cap lowered below what it holds (the owner's envelope, or a VM shrunk): want 0, and all three run on.
    h.units(3);
    h.advance(31);
    h.ticks(&mut d, 12);
    assert_eq!(h.pool.last_claim()["want"], 0);
    assert_eq!(h.leases().len(), 3);
    for n in 0..3 {
        assert!(
            h.engine.has(200 + n, &gen_of(n)),
            "nothing running is killed for a lower cap"
        );
    }
    assert!(h.pool.fails_of(200).is_empty());
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
fn a_reboot_podman_shows_as_exit_0_or_a_shutdowns_sigterm_with_a_verdict_fails_lost() {
    // Podman resets a container that ran at the reboot to `exited`, its exit code a stale 0, no verdict …
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    drop(d);
    std::fs::write(h.tdir(7, GEN).join("log/task.log"), "half a build\n").unwrap();
    h.engine.exit(7, GEN, 0, false);
    let mut d = h.dispatcher();
    h.ticks(&mut d, 1);
    let f = h.pool.fails_of(7);
    assert_eq!(f.len(), 1);
    assert_eq!(
        (f[0]["lost"].clone(), f[0]["final"].clone()),
        (json!(true), json!(false)),
        "{}",
        f[0]
    );
    // … and a shutdown's SIGTERM kills the task under the script, which writes its status 143.
    h.give(community(8, GEN2));
    h.advance(31);
    h.ticks(&mut d, 3);
    h.leave(
        8,
        GEN2,
        &[(
            "verdict.json",
            br#"{"status":143,"final":true,"needs_native":false,"error":"Terminated"}"#.to_vec(),
        )],
        "Terminated\n",
    );
    h.engine.exit(8, GEN2, 143, false);
    h.ticks(&mut d, 2);
    let f = h.pool.fails_of(8);
    assert_eq!(f.len(), 1);
    assert_eq!(
        (f[0]["lost"].clone(), f[0]["final"].clone()),
        (json!(true), json!(false)),
        "{}",
        f[0]
    );
}

#[test]
fn a_staged_input_the_pool_refuses_for_good_fails_the_task_instead_of_preparing_it_forever() {
    let h = H::new();
    std::fs::create_dir_all(h.checkout.join("tests")).unwrap();
    std::fs::write(
        h.checkout.join("tests/trial.sh"),
        "#!/bin/bash\n# TRIAL_STAGE\n",
    )
    .unwrap();
    let mut d = h.dispatcher();
    // The staged package was reclaimed (its build superseded): the pool answers 404.
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
    let f = h.pool.fails_of(11);
    assert_eq!(f.len(), 1, "failed once, not prepared again every minute");
    assert_eq!(f[0]["final"], false);
    assert!(f[0]["error"].as_str().unwrap().contains("404"), "{}", f[0]);
    assert!(d.holds().is_empty() && h.engine.runs.lock().unwrap().is_empty());
}

#[test]
fn a_package_whose_extension_member_would_expand_into_memory_is_refused_before_it_is_read() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    // The package's .PKGINFO, then a long name of 1 MiB of zeros (a compressed one expands without bound).
    let info = b"pkgname = felix\npkgver = 1.0-1\narch = aarch64\n";
    let mut b = tar::Builder::new(Vec::new());
    let mut hd = tar::Header::new_gnu();
    hd.set_size(info.len() as u64);
    hd.set_mode(0o644);
    hd.set_cksum();
    b.append_data(&mut hd, ".PKGINFO", &info[..]).unwrap();
    let mut hd = tar::Header::new_gnu();
    hd.set_entry_type(tar::EntryType::GNULongName);
    hd.as_gnu_mut().unwrap().name[..13].copy_from_slice(b"././@LongLink");
    hd.set_size(1 << 20);
    hd.set_cksum();
    b.append(&hd, &vec![0u8; 1 << 20][..]).unwrap();
    let mut files = built_ok();
    files[0].1 = b.into_inner().unwrap();
    h.leave(7, GEN, &files, "built\n");
    h.engine.exit(7, GEN, 0, false);
    h.ticks(&mut d, 2);
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(f["final"], true);
    assert!(
        f["error"].as_str().unwrap().contains("extension member"),
        "{f}"
    );
    assert!(h.pool.completes_of(7).is_empty());
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

/// The Studio's file (#338): `aarch64` native, `x86_64` emulated through qemu on 16K pages.
fn emulated_lanes(h: &H) {
    std::fs::write(&h.capacity, json!({"schema":2,"at":"2026-10-01T00:00:00Z","cpus":12,"mem_gb":32,"page_kb":16,"disk_free_gb":{"work":200,"engine":150},"units":11,"job_reserved":1,"agent_slots":1,"lanes":[{"arch":"aarch64","mode":"native"},{"arch":"x86_64","mode":"emulated","via":"qemu","page16k":true}],"held_lanes":[],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}).to_string()).unwrap();
}

/// A task of `arch` leased on `lane` (as the pool's claim answer carries `build_tasks.lane`).
fn on_lane(mut t: Value, arch: &str, lane: Option<&str>) -> Value {
    t["task"]["arch"] = json!(arch);
    t["task"]["lane"] = json!(lane);
    t
}

#[test]
fn only_a_task_on_an_emulated_lane_is_told_so_and_each_runs_its_lanes_platform() {
    let h = H::new();
    emulated_lanes(&h);
    let mut d = h.dispatcher();
    let gen3 = "g_00000000000000c3";
    // An x86_64 build on the emulated lane, an aarch64 one on the native lane, and an audit of
    // an x86_64 build (no lane: it reads its build as data, natively).
    h.give(on_lane(community(7, GEN), "x86_64", Some("emulated")));
    h.give(on_lane(community(8, GEN2), "aarch64", Some("native")));
    for name in ["PKGBUILD", "build.log"] {
        h.pool
            .artifacts
            .lock()
            .unwrap()
            .insert((5, name.into()), b"x".to_vec());
    }
    h.give(on_lane(
        task(
            9,
            "audit",
            "felix",
            "",
            "community",
            json!({"task": 5}),
            gen3,
        ),
        "x86_64",
        None,
    ));
    h.ticks(&mut d, 6);
    let labels = |a: &[String]| -> Vec<String> {
        a.windows(2)
            .filter(|w| w[0] == "-e" && w[1].starts_with("WORKER_LABELS="))
            .map(|w| w[1].clone())
            .collect()
    };
    let a = h.engine.args(7, GEN);
    assert_eq!(value_of(&a, "--platform"), Some("linux/amd64"));
    assert_eq!(labels(&a), [r#"WORKER_LABELS={"emulated":true}"#]);
    let a = h.engine.args(8, GEN2);
    assert_eq!(value_of(&a, "--platform"), Some("linux/arm64"));
    assert!(
        labels(&a).is_empty(),
        "a native lane's container is told nothing: {a:?}"
    );
    let a = h.engine.args(9, gen3);
    assert_eq!(value_of(&a, "--platform"), Some("linux/arm64"));
    assert!(labels(&a).is_empty(), "an audit runs natively: {a:?}");
    // The lease files keep each lane, so a restarted dispatcher starts the same container.
    let lanes: BTreeMap<u64, (String, bool)> = h
        .leases()
        .iter()
        .map(|l| (l.task.id, (l.arch().to_owned(), l.emulated())))
        .collect();
    assert_eq!(lanes[&7], ("x86_64".to_owned(), true));
    assert_eq!(lanes[&8], ("aarch64".to_owned(), false));
    assert_eq!(lanes[&9], ("aarch64".to_owned(), false));
    // A toolchain that could not start under qemu: the script's verdict goes to the pool as it said.
    h.leave(
        7,
        GEN,
        &[(
            "verdict.json",
            br#"{"status":96,"final":false,"needs_native":true,"error":"rustc cannot start on this worker"}"#.to_vec(),
        )],
        "==> rustc cannot start on this worker: emulated x86_64 under qemu\n",
    );
    h.engine.exit(7, GEN, 96, false);
    h.ticks(&mut d, 2);
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(
        (f["needs_native"].clone(), f["final"].clone()),
        (json!(true), json!(false))
    );
}

#[test]
fn a_lease_on_a_lane_this_host_does_not_run_is_given_back_its_attempt_with_it() {
    let h = H::new();
    let mut d = h.dispatcher();
    // The agent turned the x86_64 lane off (or never had it): the pool's emulated lease is handed back.
    h.give(on_lane(community(7, GEN), "x86_64", Some("emulated")));
    // A native lease of an architecture that is not this host's.
    h.give(on_lane(community(8, GEN2), "x86_64", Some("native")));
    // A lane word this dispatcher does not know.
    h.give(on_lane(
        community(9, "g_00000000000000c3"),
        "aarch64",
        Some("sideways"),
    ));
    h.ticks(&mut d, 5);
    for id in [7, 8, 9] {
        let f = &h.pool.fails_of(id)[0];
        assert_eq!(
            (f["lost"].clone(), f["final"].clone()),
            (json!(true), json!(false)),
            "{id}: {f}"
        );
        assert!(
            f["error"].as_str().unwrap().contains("this host runs no"),
            "{f}"
        );
    }
    assert!(
        h.engine.runs.lock().unwrap().is_empty(),
        "nothing was started"
    );
    assert!(h.leases().is_empty());
    // Its emulated lane on, but no x86_64 build image by digest: not offered, and not started.
    emulated_lanes(&h);
    let mut d = h.dispatcher_with(
        Timing::default(),
        Images {
            aarch64: IMAGE.into(),
            x86_64: "archlinux:latest".into(),
        },
    );
    h.advance(120);
    h.ticks(&mut d, 2);
    let lanes = h.pool.last_claim()["capacity"]["lanes"].clone();
    assert_eq!(
        lanes,
        json!([{"arch":"aarch64","mode":"native"}]),
        "{lanes}"
    );
    h.give(on_lane(community(10, GEN), "x86_64", Some("emulated")));
    h.advance(120);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.fails_of(10)[0]["lost"], true);
    // With the image: offered, as the agent wrote it.
    let mut d = h.dispatcher();
    h.advance(120);
    h.ticks(&mut d, 2);
    assert_eq!(
        h.pool.last_claim()["capacity"]["lanes"][1],
        json!({"arch":"x86_64","mode":"emulated","via":"qemu","page16k":true})
    );
}

#[test]
fn a_lease_prepared_again_after_a_restart_is_given_back_when_its_emulated_lane_went_off() {
    let h = H::new();
    emulated_lanes(&h);
    let mut d = h.dispatcher();
    h.give(on_lane(community(7, GEN), "x86_64", Some("emulated")));
    d.tick(); // claimed on the emulated lane, Preparing
    drop(d);
    // The owner's `emulate = []` (or binfmt gone): the agent rewrote the file without the lane,
    // and the run loop started a new dispatcher, which prepares the lease again.
    h.capacity_file(11, 150, "2026-10-01T01:00:00Z");
    let mut d = h.dispatcher();
    h.ticks(&mut d, 3);
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(
        (f["lost"].clone(), f["final"].clone()),
        (json!(true), json!(false)),
        "{f}"
    );
    assert!(
        f["error"]
            .as_str()
            .unwrap()
            .contains("no emulated lane of x86_64 now"),
        "{f}"
    );
    assert!(
        h.engine.runs.lock().unwrap().is_empty(),
        "nothing was started"
    );
    assert!(h.leases().is_empty());
    // With the lane still on, the same restart starts it on that lane.
    emulated_lanes(&h);
    let mut d = h.dispatcher();
    h.give(on_lane(community(8, GEN2), "x86_64", Some("emulated")));
    d.tick();
    drop(d);
    let mut d = h.dispatcher();
    h.ticks(&mut d, 3);
    assert_eq!(
        value_of(&h.engine.args(8, GEN2), "--platform"),
        Some("linux/amd64")
    );
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
    let removals_of_9 = || {
        h.engine
            .removed
            .lock()
            .unwrap()
            .iter()
            .filter(|(t, _)| *t == 9)
            .count()
    };
    let before = removals_of_9();
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
    assert_eq!(removals_of_9(), before, "the other lease is not touched");
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
    // The pool would hand the same build straight back: the claims leave builds out until its
    // budget fits; trials, audits and pool jobs are still claimed.
    let held = with_jobs(&["trial", "audit"]);
    h.give(community(7, GEN2));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert_eq!(h.pool.last_claim()["kinds"], held);
    assert_eq!(h.pool.last_claim()["want"], 1);
    assert_eq!(
        h.pool.fails_of(7).len(),
        2,
        "the replayed build is given back, not started"
    );
    assert!(h.engine.runs.lock().unwrap().is_empty());
    h.advance(31);
    h.ticks(&mut d, 1);
    assert_eq!(h.pool.last_claim()["kinds"], held, "still short");
    *h.free.lock().unwrap() = Some(30);
    h.advance(31);
    h.ticks(&mut d, 1);
    assert_eq!(
        h.pool.last_claim()["kinds"],
        with_jobs(&KINDS),
        "its budget plus the floor is free again"
    );
    // A budget this host never fits holds builds out for DISK_HOLD at most: the host is not stranded.
    *h.free.lock().unwrap() = Some(25);
    h.give(community(8, GEN));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert_eq!(h.pool.fails_of(8).len(), 1);
    assert_eq!(h.pool.last_claim()["kinds"], held);
    h.advance(DISK_HOLD - 60);
    h.ticks(&mut d, 1);
    assert_eq!(h.pool.last_claim()["kinds"], held);
    h.advance(61);
    h.ticks(&mut d, 1);
    assert_eq!(
        h.pool.last_claim()["kinds"],
        with_jobs(&KINDS),
        "the hold ended"
    );
    assert_eq!(h.pool.last_claim()["want"], 1);
}

#[test]
fn a_task_above_the_units_the_claim_offered_is_given_back_never_started() {
    let h = H::new();
    let mut d = h.dispatcher();
    let mut big = community(7, GEN);
    big["task"]["units"] = json!(12); // 11 units, one kept for a pool job
    h.give(big);
    h.ticks(&mut d, 2);
    assert!(h.engine.runs.lock().unwrap().is_empty());
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(
        (f["lost"].clone(), f["final"].clone()),
        (json!(true), json!(false))
    );
    // A host whose one unit is the pool jobs' wants a pool job only; a task the pool hands it anyway is
    // given back too.
    h.units(1);
    h.give(community(8, GEN2));
    h.advance(31);
    h.ticks(&mut d, 2);
    assert_eq!(
        h.pool.claim_bodies.lock().unwrap().last().unwrap()["want"],
        1
    );
    assert_eq!(h.pool.fails_of(8).len(), 1);
    assert!(h.engine.runs.lock().unwrap().is_empty() && h.leases().is_empty());
}

#[test]
fn a_kill_that_does_not_take_keeps_the_lease_and_its_units_until_the_container_is_gone() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.engine.stuck.store(true, Ordering::SeqCst);
    h.pool
        .beats
        .lock()
        .unwrap()
        .insert(7, BeatMode::Stop("cancelled".into()));
    h.advance(301);
    h.ticks(&mut d, 3);
    assert!(h.engine.has(7, GEN), "the kill did not take");
    assert!(h.pool.fails_of(7).is_empty(), "nothing reported yet");
    assert_eq!(
        d.holds(),
        vec![(7, GEN.to_owned())],
        "the lease and its units stay"
    );
    assert_eq!(h.leases().len(), 1, "and its lease file");
    h.engine.stuck.store(false, Ordering::SeqCst);
    h.ticks(&mut d, 2);
    assert!(!h.engine.has(7, GEN));
    assert_eq!(h.pool.fails_of(7).len(), 1);
    assert!(d.holds().is_empty() && h.leases().is_empty());
}

#[test]
fn a_low_engine_disk_kills_the_youngest_build_once_per_probe() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.give(community(8, GEN2));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(h.engine.has(7, GEN) && h.engine.has(8, GEN2));
    h.capacity_file(11, 5, "2026-10-01T01:00:00Z");
    h.ticks(&mut d, 3);
    assert!(!h.engine.has(8, GEN2), "the youngest build is killed");
    assert!(h.engine.has(7, GEN), "and only one for this probe's value");
    assert!(h.pool.fails_of(8)[0]["error"]
        .as_str()
        .unwrap()
        .contains("disk watcher"));
    h.capacity_file(11, 5, "2026-10-01T01:05:00Z");
    h.ticks(&mut d, 1);
    assert!(
        !h.engine.has(7, GEN),
        "a new probe still short kills the next"
    );
    h.capacity_file(11, 150, "2026-10-01T01:10:00Z");
    h.advance(31);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.last_claim()["want"], 1);
}

#[test]
fn a_tick_spends_a_bounded_time_on_a_pool_that_holds_its_heartbeats() {
    let h = H::new();
    let mut d = h.dispatcher_with(
        Timing {
            stall: Duration::from_millis(300),
            ..Timing::default()
        },
        Images {
            aarch64: IMAGE.into(),
            x86_64: IMAGE.into(),
        },
    );
    for (id, gen) in [(7, GEN), (8, GEN2), (9, "g_00000000000000c3")] {
        h.give(community(id, gen));
        h.ticks(&mut d, 3);
        h.advance(31);
    }
    assert_eq!(d.holds().len(), 3);
    *h.pool.slow_beat.lock().unwrap() = Duration::from_millis(150);
    h.pool.down.store(true, Ordering::SeqCst);
    h.pool.beat_tokens.lock().unwrap().clear();
    h.advance(301);
    let t0 = std::time::Instant::now();
    d.tick();
    assert!(
        h.pool.beat_tokens.lock().unwrap().len() < 3,
        "past a third of the stall, the other heartbeats wait for the next tick"
    );
    assert!(t0.elapsed() < Duration::from_millis(300));
    // Every lease's own watchdog runs whatever the pool does.
    h.advance(35 * 60);
    d.tick();
    h.advance(3);
    d.tick();
    assert!(
        !h.engine.has(7, GEN) && !h.engine.has(8, GEN2) && !h.engine.has(9, "g_00000000000000c3")
    );
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
    emulated_lanes(&h);
    let mut d = h.dispatcher_with(
        Timing::default(),
        Images {
            aarch64: IMAGE.into(),
            x86_64: "docker.io/library/archlinux:base-devel".into(),
        },
    );
    h.give(on_lane(community(7, GEN), "x86_64", Some("emulated")));
    h.ticks(&mut d, 3);
    assert!(h.engine.runs.lock().unwrap().is_empty());
    let f = &h.pool.fails_of(7)[0];
    assert!(f["error"]
        .as_str()
        .unwrap()
        .contains("not an image by digest"));
    assert_eq!(
        (f["lost"].clone(), f["final"].clone()),
        (json!(true), json!(false)),
        "the host's image, not the task: given back"
    );
    // A host whose native lane's image is not a digest claims nothing.
    let mut d = h.dispatcher_with(
        Timing::default(),
        Images {
            aarch64: String::new(),
            x86_64: IMAGE.into(),
        },
    );
    h.advance(31);
    h.ticks(&mut d, 1);
    assert_eq!(h.pool.last_claim()["want"], 0);
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
        args.contains("ANTHROPIC_BASE_URL=http://10.231.0.3:8790"),
        "a model kind talks to its agent sidecar: {args}"
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
        .contains("--cpus 0.650 --memory 1728m"));
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
        h.pool.answers.lock().unwrap().len(),
        1,
        "answered once the probe has spoken"
    );
    h.advance(3);
    d.tick();
    let a = h.pool.answers.lock().unwrap()[1].clone();
    assert_eq!(
        (a.0.as_str(), &a.1["outcome"], &a.1["code"]),
        (id2.as_str(), &json!("done"), &json!("probed"))
    );
    h.advance(60);
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
    // Nor an agent key or a GitHub token (invariant 5): agent.env is the agent sidecars' alone.
    assert!(super::refuse_agent_key(env("OMARCHY_SECRETS_DIR", "/srv/s")).is_ok());
    assert!(super::refuse_agent_key(env("GITHUB_TOKEN", "")).is_ok());
    for k in [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GEMINI_API_KEY",
        "GITHUB_TOKEN",
    ] {
        let e = super::refuse_agent_key(env(k, "x"))
            .unwrap_err()
            .to_string();
        assert!(e.contains(k) && e.contains("agent.env"), "{e}");
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
    h.leave(
        11,
        GEN,
        &[("verdict.json", br#"{"status":0}"#.to_vec())],
        "== pacman -Sy\nTRIAL=ok\n",
    );
    h.engine.exit(11, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.staged_of(5), ["trial.log"]);
    let done = &h.pool.completes_of(11)[0];
    assert_eq!(done["result"]["verdict"], "ok");
    assert_eq!(h.pool.events.lock().unwrap()[0]["status"], "ok");
}

#[test]
fn a_trial_of_a_release_whose_trial_sh_predates_staging_is_refused_before_anything_runs() {
    let h = H::new();
    std::fs::create_dir_all(h.checkout.join("tests")).unwrap();
    std::fs::write(
        h.checkout.join("tests/trial.sh"),
        "#!/bin/bash\ndocker run --rm archlinux true\n",
    )
    .unwrap();
    let mut d = h.dispatcher();
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
    assert!(h.pool.published.lock().unwrap().is_empty());
    assert!(h.engine.runs.lock().unwrap().is_empty());
    assert!(h.pool.fails_of(11)[0]["error"]
        .as_str()
        .unwrap()
        .contains("TRIAL_STAGE"));
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
fn sigterm_sends_no_heartbeat_more_and_the_leases_run_on() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    h.pool.beat_tokens.lock().unwrap().clear();
    h.advance(301);
    d.terminating.store(true, Ordering::SeqCst);
    d.tick();
    assert!(
        h.pool.beat_tokens.lock().unwrap().is_empty(),
        "a pool that does not answer would hold the exit past the stop grace period"
    );
    assert!(h.engine.has(7, GEN) && h.leases().len() == 1);
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

// ---------- task networks and sidecars (#336) ----------

/// Two staged builds an audit and a review rebuild can learn from.
fn stage_evidence(h: &H, of: &[u64]) {
    for id in of {
        let mut a = h.pool.artifacts.lock().unwrap();
        a.insert((*id, "PKGBUILD".into()), b"pkgname=felix".to_vec());
        a.insert((*id, "build.log".into()), b"log".to_vec());
    }
}

fn audit(id: u64, of: u64, gen: &str) -> Value {
    task(
        id,
        "audit",
        "felix",
        "",
        "community",
        json!({ "task": of }),
        gen,
    )
}

fn review(id: u64, of: u64, gen: &str) -> Value {
    task(
        id,
        "build",
        "felix",
        &format!("review:{of}"),
        "project",
        json!({ "review": of, "project": "https://felix.example" }),
        gen,
    )
}

fn sidecar(id: u64, gen: &str, role: &str) -> String {
    format!("{}-{role}", spec::container_name(id, gen))
}

#[test]
fn every_task_gets_its_own_internal_network_and_egress_sidecar() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    let net = spec::container_name(7, GEN);
    let egress = sidecar(7, GEN, "egress");
    assert!(h.engine.has_network(&net) && h.engine.has_name(&egress));
    assert!(
        !h.engine.has_name(&sidecar(7, GEN, "agent")),
        "a build has no agent"
    );
    let create = h
        .engine
        .calls
        .lock()
        .unwrap()
        .iter()
        .find(|c| c[..2] == ["network", "create"] && c.last() == Some(&net))
        .cloned()
        .unwrap();
    assert!(create.contains(&"--internal".to_owned()), "{create:?}");
    // The task is on its network only; its egress on that one and the shared bridge; the dispatcher on neither.
    assert_eq!(h.engine.attached(&net), vec![net.clone()]);
    let mut on = h.engine.attached(&egress);
    on.sort();
    assert_eq!(on, vec![spec::EGRESS_NETWORK.to_owned(), net.clone()]);
    assert_eq!(
        h.engine.containers.lock().unwrap()[&egress].0.status,
        "running"
    );
    let lease = &h.leases()[0];
    assert!(lease.net_slot.is_some());
    // Its end removes its container, its sidecar and its network; the shared bridge stays.
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.completes_of(7).len(), 1);
    assert!(!h.engine.has(7, GEN) && !h.engine.has_name(&egress) && !h.engine.has_network(&net));
    assert!(h.engine.has_network(spec::EGRESS_NETWORK));
}

#[test]
fn two_model_tasks_each_get_their_own_agent_sidecar_and_stopping_one_removes_only_its_own() {
    let h = H::new();
    let mut d = h.dispatcher();
    stage_evidence(&h, &[5, 6]);
    h.give(audit(9, 5, GEN));
    h.give(review(10, 6, GEN2));
    h.ticks(&mut d, 4);
    let (a9, a10) = (sidecar(9, GEN, "agent"), sidecar(10, GEN2, "agent"));
    assert!(h.engine.has(9, GEN) && h.engine.has(10, GEN2));
    assert!(
        h.engine.has_name(&a9) && h.engine.has_name(&a10),
        "one agent sidecar each"
    );
    let (n9, n10) = (spec::container_name(9, GEN), spec::container_name(10, GEN2));
    assert_eq!(
        h.engine.attached(&a9),
        vec![n9.clone()],
        "an agent sidecar is on its task's network only"
    );
    assert_eq!(h.engine.attached(&a10), vec![n10.clone()]);
    // Each points at its own: the audit's container at the audit's agent, never the rebuild's.
    let ip = |args: &[String], k: &str| {
        args.iter()
            .find_map(|a| a.strip_prefix(&format!("{k}=")))
            .unwrap()
            .to_owned()
    };
    let (t9, t10) = (h.engine.args(9, GEN), h.engine.args(10, GEN2));
    assert_ne!(
        ip(&t9, "ANTHROPIC_BASE_URL"),
        ip(&t10, "ANTHROPIC_BASE_URL")
    );
    let agent_ip = |name: &str| {
        value_of(&h.engine.args_of(name), "--ip")
            .unwrap()
            .to_owned()
    };
    assert_eq!(
        ip(&t9, "ANTHROPIC_BASE_URL"),
        format!("http://{}:8790", agent_ip(&a9))
    );
    assert_eq!(
        ip(&t10, "ANTHROPIC_BASE_URL"),
        format!("http://{}:8790", agent_ip(&a10))
    );
    // The agent's keys reach the sidecar only, as a read-only file; no task container holds them.
    let keys =
        "type=bind,source=/srv/omarchy/secrets/agent.env,target=/run/omarchy/agent.env,readonly";
    assert!(h.engine.args_of(&a9).iter().any(|a| a == keys));
    assert!(
        !t9.iter().any(|a| a.contains("agent.env")) && !t9.iter().any(|a| a.contains("/agent:"))
    );
    // The pool stops the audit: its container, its sidecars and its network go, nothing of the rebuild's.
    h.pool
        .beats
        .lock()
        .unwrap()
        .insert(9, BeatMode::Stop("cancelled".into()));
    h.advance(301);
    h.ticks(&mut d, 2);
    assert!(!h.engine.has(9, GEN) && !h.engine.has_name(&a9));
    assert!(!h.engine.has_name(&sidecar(9, GEN, "egress")) && !h.engine.has_network(&n9));
    assert!(h.engine.has(10, GEN2) && h.engine.has_name(&a10) && h.engine.has_network(&n10));
    assert!(h.engine.has_name(&sidecar(10, GEN2, "egress")));
    assert_eq!(d.holds(), vec![(10, GEN2.to_owned())]);
}

#[test]
fn a_compromised_task_reaches_no_other_tasks_network_or_agent() {
    let h = H::new();
    let mut d = h.dispatcher();
    stage_evidence(&h, &[5]);
    h.give(community(7, GEN));
    h.give(audit(9, 5, GEN2));
    h.ticks(&mut d, 4);
    // What a recipe in task 7 can address: the containers on the networks its container is on.
    let reach = |id: u64, gen: &str| -> Vec<String> {
        let mine = h.engine.attached(&spec::container_name(id, gen));
        let nets = h.engine.networks.lock().unwrap();
        mine.iter().flat_map(|n| nets[n].1.clone()).collect()
    };
    let from7 = reach(7, GEN);
    assert_eq!(
        {
            let mut v = from7.clone();
            v.sort();
            v
        },
        vec![spec::container_name(7, GEN), sidecar(7, GEN, "egress")],
        "task 7 sees its own egress, nothing of task 9's"
    );
    assert!(!from7.iter().any(|c| c.contains("-9-")));
    // No task container and no agent sidecar is on the shared bridge; each egress is, and listens on nothing there.
    let bridge = h.engine.networks.lock().unwrap()[spec::EGRESS_NETWORK]
        .1
        .clone();
    assert!(bridge.iter().all(|c| c.ends_with("-egress")), "{bridge:?}");
    // The subnets differ, and each egress refuses the whole task range.
    let subnet = |id: u64, gen: &str| {
        let net = spec::container_name(id, gen);
        let calls = h.engine.calls.lock().unwrap();
        let c = calls
            .iter()
            .find(|c| c[..2] == ["network", "create"] && c.last() == Some(&net))
            .unwrap();
        value_of(c, "--subnet").unwrap().to_owned()
    };
    assert_ne!(subnet(7, GEN), subnet(9, GEN2));
    let e7 = h.engine.args_of(&sidecar(7, GEN, "egress"));
    assert!(
        e7.windows(2)
            .any(|w| w[0] == "--deny" && w[1] == "10.231.0.0/16"),
        "{e7:?}"
    );
    // Nothing on a task network holds the socket or a token.
    for (name, c) in h.engine.containers.lock().unwrap().iter() {
        let all = c.2.join(" ");
        assert!(
            !all.contains("docker.sock")
                && !all.contains("omj.")
                && !all.contains("omw_")
                && !all.contains("OMARCHY_WORKER_TOKEN"),
            "{name}: {all}"
        );
    }
}

#[test]
fn per_task_caps_go_to_the_sidecar_and_the_per_day_budget_stops_new_model_tasks() {
    let h = H::new();
    let mut d = h.dispatcher();
    d.net.caps = super::budget::Caps {
        calls_per_task: 200,
        tokens_per_task: 50_000,
        minutes_per_task: 30,
        calls_per_day: 250,
    };
    stage_evidence(&h, &[5, 6, 8]);
    h.give(audit(9, 5, GEN));
    h.ticks(&mut d, 3);
    let caps = |name: &str| {
        let a = h.engine.args_of(name);
        [
            "BROKER_AGENT_CALLS",
            "BROKER_AGENT_TOKENS",
            "BROKER_AGENT_WALL_SECONDS",
        ]
        .map(|k| {
            a.iter()
                .find_map(|x| x.strip_prefix(&format!("{k}=")))
                .unwrap()
                .to_owned()
        })
    };
    assert_eq!(caps(&sidecar(9, GEN, "agent")), ["200", "50000", "1800"]);
    // The probe sidecar's call at start is the day's too.
    assert_eq!(
        super::budget::Ledger::new(&h.work).spent(h.now.load(Ordering::SeqCst)),
        1
    );
    // A second model task while the first runs: what the day has left once the first's cap and the probe's call are set aside.
    h.give(review(10, 6, GEN2));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert_eq!(caps(&sidecar(10, GEN2, "agent"))[0], "49");
    // The day is spoken for: the claims offer no agent slot, and a model task handed anyway does not start.
    h.advance(31);
    h.ticks(&mut d, 1);
    assert_eq!(h.pool.last_claim()["capacity"]["agent_slots"], 0);
    h.give(audit(11, 8, "g_00000000000000c3"));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(!h.engine.has(11, "g_00000000000000c3"));
    let f = &h.pool.fails_of(11)[0];
    assert!(
        f["lost"] == true && f["error"].as_str().unwrap().contains("agent budget"),
        "{f}"
    );
    // A build needs no agent and starts.
    h.give(community(12, "g_00000000000000d4"));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(h.engine.has(12, "g_00000000000000d4"));
    // The audit ends having made 17 calls (its sidecar's usage file): the day counts 17 more, and 32 are free again.
    std::fs::write(
        h.tdir(9, GEN).join("agent/usage.json"),
        r#"{"calls":17,"tokens":4000}"#,
    )
    .unwrap();
    h.leave(
        9,
        GEN,
        &[
            ("audit.json", br#"{"verdict":"ok"}"#.to_vec()),
            ("audit.md", b"# ok".to_vec()),
        ],
        "log\n",
    );
    h.engine.exit(9, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert!(!h.engine.has(9, GEN));
    assert_eq!(
        super::budget::Ledger::new(&h.work).spent(h.now.load(Ordering::SeqCst)),
        18
    );
    h.advance(31);
    h.ticks(&mut d, 1);
    assert_ne!(
        h.pool.last_claim()["capacity"]["agent_slots"],
        0,
        "the day has calls left again"
    );
    // A new day: the budget is whole.
    h.advance(86_400);
    assert_eq!(
        super::budget::Ledger::new(&h.work).spent(h.now.load(Ordering::SeqCst)),
        0
    );
}

#[test]
fn a_package_with_its_signed_exception_gets_a_bridge_network_and_no_egress() {
    let h = H::new();
    std::fs::create_dir_all(h.checkout.join("factory/sizing")).unwrap();
    std::fs::write(
        h.checkout.join("factory/sizing/tasks.toml"),
        "schema = 1\n[package.\"felix\"]\nnetwork = \"direct\"\nreason = \"its tests open raw sockets\"\n",
    )
    .unwrap();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    let net = spec::container_name(7, GEN);
    assert!(h.engine.has(7, GEN) && h.engine.has_network(&net));
    let create = h
        .engine
        .calls
        .lock()
        .unwrap()
        .iter()
        .find(|c| c[..2] == ["network", "create"] && c.last() == Some(&net))
        .cloned()
        .unwrap();
    assert!(
        !create.contains(&"--internal".to_owned()),
        "a bridge network: {create:?}"
    );
    assert!(!h.engine.has_name(&sidecar(7, GEN, "egress")));
    assert!(!h
        .engine
        .args(7, GEN)
        .join(" ")
        .to_ascii_lowercase()
        .contains("proxy"));
    // Another package of the same release has none.
    h.give(task(
        8,
        "build",
        "other",
        "https://github.com/o/o@v1:PKGBUILD",
        "community",
        json!({}),
        GEN2,
    ));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(h.engine.has_name(&sidecar(8, GEN2, "egress")));
    // A sizing file a release broke fails the task before the engine runs, never widens it.
    std::fs::write(
        h.checkout.join("factory/sizing/tasks.toml"),
        "schema = 1\n[package.\"felix\"]\nnetwork = \"direct\"\n",
    )
    .unwrap();
    h.give(community(9, "g_00000000000000c3"));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(!h.engine.has(9, "g_00000000000000c3"));
    assert!(h.pool.fails_of(9)[0]["error"]
        .as_str()
        .unwrap()
        .contains("sizing"));
}

#[test]
fn orphan_sidecars_and_networks_of_this_host_go_at_start_and_nothing_else() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    drop(d);
    // A lease that left its sidecar and network behind, a probe's leftovers, and another host's.
    let stale = "g_00000000000000e5";
    for (name, host) in [
        (sidecar(12, stale, "egress"), HOST),
        (sidecar(12, stale, "agent"), HOST),
        (sidecar(0, stale, "egress"), HOST),
        (sidecar(13, stale, "egress"), "h_other"),
    ] {
        h.engine.put(&name, "running", host);
    }
    for (name, host) in [
        (spec::container_name(12, stale), HOST),
        (spec::container_name(0, stale), HOST),
        (spec::container_name(13, stale), "h_other"),
        ("omarchy-legacy_default".to_owned(), ""),
    ] {
        h.engine
            .networks
            .lock()
            .unwrap()
            .insert(name, (host.to_owned(), Vec::new()));
    }
    let _d = h.dispatcher();
    assert!(
        h.engine.has(7, GEN) && h.engine.has_name(&sidecar(7, GEN, "egress")),
        "the held lease's are adopted"
    );
    assert!(h.engine.has_network(&spec::container_name(7, GEN)));
    for gone in [
        sidecar(12, stale, "egress"),
        sidecar(12, stale, "agent"),
        sidecar(0, stale, "egress"),
    ] {
        assert!(!h.engine.has_name(&gone), "{gone}");
    }
    assert!(!h.engine.has_network(&spec::container_name(12, stale)));
    assert!(!h.engine.has_network(&spec::container_name(0, stale)));
    assert!(
        h.engine.has_name(&sidecar(13, stale, "egress")),
        "another host's"
    );
    assert!(h.engine.has_network(&spec::container_name(13, stale)));
    assert!(
        h.engine.has_network("omarchy-legacy_default"),
        "another project's network"
    );
}

#[test]
fn a_network_its_teardown_left_does_not_cost_the_next_task_on_its_slot() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    assert_eq!(h.leases()[0].net_slot, Some(0));
    // Its `network rm` does not take: the network stays on slot 0 after the lease is gone.
    h.engine.keep_network.store(true, Ordering::SeqCst);
    h.leave(7, GEN, &built_ok(), "log\n");
    h.engine.exit(7, GEN, 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.completes_of(7).len(), 1);
    assert!(h.leases().is_empty());
    assert!(h.engine.has_network(&spec::container_name(7, GEN)));
    h.engine.keep_network.store(false, Ordering::SeqCst);
    // The next task gets slot 0 again; the stale network is swept before it, so its network is made.
    h.give(community(8, GEN2));
    h.advance(31);
    h.ticks(&mut d, 3);
    assert!(h.pool.fails_of(8).is_empty(), "{:?}", h.pool.fails_of(8));
    assert!(h.engine.has(8, GEN2));
    assert_eq!(h.leases()[0].net_slot, Some(0));
    assert!(!h.engine.has_network(&spec::container_name(7, GEN)));
}

#[test]
fn a_sidecar_that_does_not_start_loses_the_lease_and_leaves_nothing() {
    let h = H::new();
    let mut d = h.dispatcher();
    stage_evidence(&h, &[5]);
    *h.engine.refuse.lock().unwrap() = Some("-agent".into());
    h.give(audit(9, 5, GEN));
    h.ticks(&mut d, 4);
    assert!(!h.engine.has(9, GEN), "no task container without its agent");
    let f = &h.pool.fails_of(9)[0];
    assert!(
        f["lost"] == true
            && f["error"]
                .as_str()
                .unwrap()
                .contains("-agent did not start"),
        "{f}"
    );
    assert!(
        !h.engine.has_name(&sidecar(9, GEN, "egress"))
            && !h.engine.has_network(&spec::container_name(9, GEN))
    );
    assert_eq!(
        super::budget::Ledger::new(&h.work).spent(h.now.load(Ordering::SeqCst)),
        1,
        "nothing of the day spent but the probe's call"
    );
}

#[test]
fn the_claim_says_who_the_agent_is_from_the_probe_sidecar() {
    let h = H::new();
    let mut d = h.dispatcher();
    d.tick();
    let agent = h.pool.last_claim()["agent"].clone();
    assert_eq!(agent["probe"], "ok");
    assert_eq!(
        (agent["provider"].as_str(), agent["model"].as_str()),
        (Some("anthropic"), Some("claude-sonnet-5"))
    );
    // The probe ran on a network of its own, which is gone.
    assert!(!h
        .engine
        .networks
        .lock()
        .unwrap()
        .keys()
        .any(|n| n.starts_with("omarchy-task-0-")));
    assert!(!h
        .engine
        .containers
        .lock()
        .unwrap()
        .keys()
        .any(|n| n.starts_with("omarchy-task-0-")));
    // An agent that stops answering: a restart-agent order is a fresh probe, answered by its outcome.
    *h.engine.probe_says.lock().unwrap() = Some(
        r#"{"ok": false, "provider": "anthropic", "error": "HTTP 401: invalid x-api-key"}"#.into(),
    );
    h.advance(121);
    h.give(json!({ "task": null, "orders": [{ "id": format!("wo_{}", "4".repeat(32)), "kind": "restart-agent", "reason": "test", "issued_by": "maintainer" }] }));
    h.ticks(&mut d, 2);
    let a = h.pool.answers.lock().unwrap()[0].1.clone();
    assert_eq!(
        (&a["outcome"], &a["code"]),
        (&json!("failed"), &json!("not-answering")),
        "{a}"
    );
    h.advance(61);
    h.ticks(&mut d, 1);
    let agent = h.pool.last_claim()["agent"].clone();
    assert_eq!(agent["probe"], "error");
    assert!(agent["error"].as_str().unwrap().contains("401"));
    // A host with no agent key says so, and takes no probe.
    let h2 = H::new();
    let mut d2 = h2.dispatcher();
    d2.net.secrets_dir = None;
    d2.tick();
    assert_eq!(h2.pool.last_claim()["agent"]["probe"], "error");
    assert!(h2.pool.last_claim()["agent"]["error"]
        .as_str()
        .unwrap()
        .contains("no agent key"));
}

// ---------- revoked releases (#342) ----------

/// A newer release's manifest, as a stub: it revokes v1.2.3, the release `task()` leases on.
const REVOKING: &str =
    "min_release = \"v1.0.0\"\nrevoked = [\"v1.2.3\"]\npools = [\"https://pool.example\"]\n";

/// A task leased on `release` (as the pool's claim answer carries `build_tasks.release`).
fn on_release(mut t: Value, release: &str) -> Value {
    t["task"]["release"] = json!(release);
    t
}

#[test]
fn a_dispatcher_whose_manifest_revokes_a_running_tasks_release_kills_it_and_reports_it_and_older_tasks_finish(
) {
    let h = H::new();
    let mut d = h.dispatcher();
    // Three leases of the release before: one on v1.2.3 running, one on v1.2.3 whose container
    // exits while the dispatcher is replaced, and one on v1.2.2, older and not revoked.
    h.give(community(7, GEN));
    h.give(community(8, GEN2));
    h.give(on_release(community(9, &gen_of(9)), "v1.2.2"));
    h.ticks(&mut d, 6);
    assert!(h.engine.has(7, GEN) && h.engine.has(8, GEN2) && h.engine.has(9, &gen_of(9)));
    drop(d);
    h.leave(8, GEN2, &built_ok(), "==> Finished making: felix\n");
    h.engine.exit(8, GEN2, 0, false);
    // The next release's dispatcher: its signed manifest revokes v1.2.3.
    let mut d = h.dispatcher();
    d.revoke_signed(&super::revoked::of_manifest(REVOKING).unwrap());
    h.ticks(&mut d, 2);
    for (id, gen) in [(7, GEN), (8, GEN2)] {
        assert!(
            !h.engine.has(id, gen),
            "task {id}'s containers are killed by label"
        );
        let f = h.pool.fails_of(id);
        assert_eq!(f.len(), 1, "task {id} reported once: {f:?}");
        assert_eq!(f[0]["revoked"], true);
        assert_eq!(
            f[0]["lost"], true,
            "a pool from before #342 gives the attempt back"
        );
        assert_eq!(f[0]["final"], false);
        assert!(
            f[0]["error"]
                .as_str()
                .unwrap()
                .contains("release v1.2.3 is revoked"),
            "{f:?}"
        );
        assert!(
            h.pool.completes_of(id).is_empty(),
            "nothing of task {id} completed"
        );
    }
    assert!(
        h.pool.staged_of(8).is_empty(),
        "nothing of the exited one uploaded"
    );
    assert_eq!(
        h.leases().iter().map(|l| l.task.id).collect::<Vec<_>>(),
        vec![9],
        "only the older release's lease is left"
    );
    // The older release's task finishes on the release it started with.
    assert!(h.engine.has(9, &gen_of(9)), "not touched");
    h.leave(9, &gen_of(9), &built_ok(), "==> Finished making: felix\n");
    h.engine.exit(9, &gen_of(9), 0, false);
    h.ticks(&mut d, 2);
    assert_eq!(h.pool.completes_of(9).len(), 1, "completed normally");
    assert!(h.pool.fails_of(9).is_empty());
    // The set is kept on the host: a dispatcher of an older release, whose manifest revokes nothing
    // (a rollback), still kills a lease of v1.2.3.
    drop(d);
    let mut d = h.dispatcher();
    h.advance(31);
    h.give(community(10, &gen_of(10)));
    h.ticks(&mut d, 4);
    assert!(!h.engine.has(10, &gen_of(10)));
    assert_eq!(h.pool.fails_of(10)[0]["revoked"], true);
}

#[test]
fn the_pools_word_at_a_heartbeat_kills_a_lease_and_reports_it_revoked_and_is_not_kept() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    assert!(h.engine.has(7, GEN));
    h.pool
        .beats
        .lock()
        .unwrap()
        .insert(7, BeatMode::Stop("revoked".into()));
    h.advance(301);
    h.ticks(&mut d, 2);
    assert!(!h.engine.has(7, GEN), "killed");
    let f = &h.pool.fails_of(7)[0];
    assert_eq!(f["revoked"], true);
    assert!(f["error"]
        .as_str()
        .unwrap()
        .contains("release v1.2.3 is revoked"));
    assert!(h.leases().is_empty());
    // The pool's word was for that lease only: a new lease of the same release starts.
    h.pool.beats.lock().unwrap().clear();
    h.advance(31);
    h.give(community(8, GEN2));
    h.ticks(&mut d, 3);
    assert!(
        h.engine.has(8, GEN2),
        "a pool cannot revoke a release on this host for good"
    );
}

#[test]
fn a_dispatcher_whose_own_release_is_revoked_here_takes_no_task_and_still_claims_for_its_orders() {
    let h = H::new();
    let mut d = h.dispatcher();
    d.tick();
    assert_eq!(
        h.pool.last_claim()["want"],
        1,
        "a release not revoked takes work"
    );
    drop(d);
    // A later release's dispatcher kept this one in the host's set, then the agent's guard reverted the
    // host to it, and the pool was rolled back onto it: its manifest does not revoke it, so it would lease.
    std::fs::create_dir_all(h.work.join("state")).unwrap();
    std::fs::write(
        h.work.join("state/revoked.json"),
        json!([pkg_manifest::BUILD_VERSION]).to_string(),
    )
    .unwrap();
    let before = h.pool.claim_bodies.lock().unwrap().len();
    let mut d = h.dispatcher();
    h.advance(31);
    // A pool that hands it a task anyway, leased on this release: given back, never started.
    h.give(on_release(community(7, GEN), pkg_manifest::BUILD_VERSION));
    h.ticks(&mut d, 3);
    h.advance(31);
    h.ticks(&mut d, 3);
    let bodies = h.pool.claim_bodies.lock().unwrap()[before..].to_vec();
    assert!(bodies.len() >= 2, "it claims on: {bodies:?}");
    assert!(
        bodies
            .iter()
            .all(|b| b["want"] == 0 && b.get("offer").is_none()),
        "every claim says want 0: {bodies:?}"
    );
    assert!(
        h.engine.runs.lock().unwrap().is_empty(),
        "no container started"
    );
    assert!(h.leases().is_empty());
    let f = h.pool.fails_of(7);
    assert_eq!(f.len(), 1, "given back once: {f:?}");
    assert_eq!(f[0]["final"], false);
    assert!(h.pool.completes_of(7).is_empty());
    // Its claims still carry its orders.
    h.advance(121);
    h.give(json!({ "task": null, "orders": [{ "id": format!("wo_{}", "5".repeat(32)), "kind": "restart", "reason": "test", "issued_by": "maintainer" }] }));
    d.tick();
    assert_eq!(d.exit, Some(75));
}

// ---------- pool jobs (#340) ----------

/// A pool job as a host's claim answer carries it: one unit, no disk, its kind's name.
#[allow(clippy::needless_pass_by_value)] // the call sites read better with json!(…) inline
fn job(id: u64, kind: &str, arch: &str, params: Value, gen: &str) -> Value {
    json!({
        "task": { "id": id, "kind": kind, "name": kind, "arch": arch, "trust": "project", "pkgbuild_ref": "-", "params": params,
                  "attempts": 1, "max_attempts": 3, "publish": 1, "lease_gen": gen, "units": 1, "disk_gb": 0, "release": "v1.2.3" },
        "token": format!("omj.secret-of-{id}"),
        "lease_minutes": 30,
    })
}

impl H {
    /// Turns the loop (3 s of the fake clock each) until `done` holds, within 10 s of real time: a
    /// pool job's child is a real process.
    fn until(&self, d: &mut Dispatcher, what: &str, done: impl Fn(&H) -> bool) {
        let until = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            d.tick();
            self.advance(3);
            if done(self) {
                return;
            }
            assert!(std::time::Instant::now() < until, "{what}: not within 10 s");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Beside the work root, outside every task directory: what a job's child leaves for the test.
    fn out(&self, name: &str) -> PathBuf {
        self.work.parent().unwrap().join(name)
    }

    fn beats_of(&self, id: u64) -> usize {
        self.pool
            .beat_tokens
            .lock()
            .unwrap()
            .iter()
            .filter(|(t, _)| *t == id)
            .count()
    }
}

/// A process the test's job started and left running in the background, by its pid file.
fn alive(pid_file: &Path) -> bool {
    let Some(pid) = std::fs::read_to_string(pid_file)
        .ok()
        .and_then(|p| p.trim().parse::<i32>().ok())
    else {
        return false;
    };
    let zombie = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .is_ok_and(|s| s.split_whitespace().nth(2) == Some("Z"));
    !zombie
        && rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid).unwrap()).is_ok()
}

fn gone(pid_file: &Path) -> bool {
    let until = std::time::Instant::now() + Duration::from_secs(5);
    while alive(pid_file) && std::time::Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    !alive(pid_file)
}

#[test]
fn an_arch_neutral_pool_job_runs_in_a_child_process_of_its_own_and_reports_what_it_returned() {
    let h = H::new();
    let mut d = h.dispatcher();
    // A render of the x86_64 ring on this aarch64-only host: arch-neutral, in the dispatcher's own
    // native process tree, as today's pool-x86_64 runs it.
    let (env, spec, token) = (h.out("env-40"), h.out("job-40.json"), h.out("token-40"));
    h.launch.set(
        40,
        &format!(
            "env > {}; cp \"$JOB_DIR/job.json\" {}; cp \"$JOB_DIR/token\" {}; {JOB_DONE}",
            env.display(),
            spec.display(),
            token.display()
        ),
    );
    h.give(job(
        40,
        "render",
        "x86_64",
        json!({ "ring": "edge", "arch": "x86_64" }),
        GEN,
    ));
    h.until(&mut d, "the render's report", |h| {
        !h.pool.completes_of(40).is_empty()
    });
    let done = &h.pool.completes_of(40)[0];
    assert_eq!(done["summary"], "edge/x86_64 rendered: omarchy-core-edge");
    assert_eq!(done["result"], json!({ "repos": ["omarchy-core-edge"] }));
    assert_eq!(
        (done["sha256"].clone(), done["filename"].clone()),
        (json!("-"), json!("-"))
    );
    // No container, no network of its own: a job without helpers reaches no engine (the probe sidecar's are the host's).
    assert!(h.engine.runs.lock().unwrap().is_empty());
    assert!(!h
        .engine
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.iter().any(|x| x.contains("omarchy-task-40-"))));
    // Its environment: the shim first on PATH and as RUNTIME, its own scratch, no worker token, no
    // stale job token (its token is in its directory), no helper context (a render starts none).
    let env = std::fs::read_to_string(&env).unwrap();
    let var = |k: &str| {
        env.lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")))
            .map(str::to_owned)
    };
    let bin = h.work.join("state/bin");
    assert!(var("PATH")
        .unwrap()
        .starts_with(&format!("{}:", bin.display())));
    assert_eq!(
        var("RUNTIME"),
        Some(bin.join("omarchy-task-run").display().to_string())
    );
    assert_eq!(
        var("TMPDIR"),
        Some(h.tdir(40, GEN).join("tmp").display().to_string())
    );
    for k in [
        "OMARCHY_WORKER_TOKEN",
        "OMARCHY_TOKEN",
        "OMARCHY_TASK_RUN",
        "OMARCHY_TASK_ID",
    ] {
        assert_eq!(var(k), None, "{k} is not a job's: {env}");
    }
    let spec: Value = serde_json::from_slice(&std::fs::read(&spec).unwrap()).unwrap();
    assert_eq!(
        (
            spec["task"]["id"].clone(),
            spec["arch"].clone(),
            spec["repo_dir"].clone(),
            spec["work_dir"].clone()
        ),
        (
            json!(40),
            json!("aarch64"),
            json!(h.checkout.display().to_string()),
            json!(h.work.join("jobs").display().to_string())
        )
    );
    assert_eq!(std::fs::read_to_string(&token).unwrap(), "omj.secret-of-40");
    assert!(
        h.leases().is_empty() && !h.tdir(40, GEN).exists(),
        "cleaned up"
    );
}

#[test]
fn a_hanging_job_is_killed_at_its_timeout_and_failed_while_the_loop_and_another_leases_heartbeats_go_on(
) {
    let h = H::new();
    let mut d = h.dispatcher();
    // A build in its container, then a health check whose job hangs, with a process it started.
    h.give(community(7, GEN));
    h.ticks(&mut d, 3);
    assert!(h.engine.has(7, GEN));
    let pid = h.out("hung.pid");
    h.launch.set(
        41,
        &format!("sleep 600 & echo $! > {}; wait", pid.display()),
    );
    h.give(job(
        41,
        "health",
        "aarch64",
        json!({ "ring": "rc", "arch": "aarch64" }),
        GEN2,
    ));
    h.until(&mut d, "the job started", |_| alive(&pid));
    let lease = h.leases().into_iter().find(|l| l.task.id == 41).unwrap();
    assert_eq!(lease.phase, Phase::Running);
    assert!(lease.net_slot.is_some(), "its helpers' /28 is held");
    let (beats, claims) = (h.beats_of(7), h.pool.claim_bodies.lock().unwrap().len());
    // 44 minutes: the loop turns, both leases beat, the build runs on, and so does the job.
    for _ in 0..(44 * 2) {
        d.tick();
        h.advance(30);
    }
    assert!(h.beats_of(7) >= beats + 8, "the build's heartbeats go on");
    assert!(h.beats_of(41) >= 8, "and the job's");
    assert!(h.pool.claim_bodies.lock().unwrap().len() > claims + 40);
    assert!(alive(&pid) && h.pool.fails_of(41).is_empty());
    // Past its 45 minutes: its process group killed, what its helpers left removed, failed — not final.
    for _ in 0..4 {
        d.tick();
        h.advance(30);
    }
    let f = h.pool.fails_of(41);
    assert_eq!(f.len(), 1, "{f:?}");
    assert!(
        f[0]["error"]
            .as_str()
            .unwrap()
            .contains("health ran past its timeout of 45 min"),
        "{f:?}"
    );
    assert_eq!(
        (f[0]["timed_out"].clone(), f[0]["final"].clone()),
        (json!(true), json!(false))
    );
    assert!(gone(&pid), "the job's own processes die with it");
    assert!(h
        .engine
        .removed
        .lock()
        .unwrap()
        .contains(&(41, GEN2.to_owned())));
    // The build runs on; the job's unit is free again.
    assert!(h.engine.has(7, GEN));
    assert_eq!(
        h.leases().iter().map(|l| l.task.id).collect::<Vec<_>>(),
        [7]
    );
    h.advance(31);
    d.tick();
    assert!(h.pool.last_claim()["kinds"]
        .as_array()
        .unwrap()
        .contains(&json!("health")));
}

#[test]
fn a_crashing_job_is_failed_with_how_it_ended_and_the_loop_goes_on() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.launch.set(42, "kill -SEGV $$");
    h.give(job(42, "gc", "x86_64", json!({ "keep": 3 }), GEN));
    h.until(&mut d, "the crash's report", |h| {
        !h.pool.fails_of(42).is_empty()
    });
    let f = &h.pool.fails_of(42)[0];
    let e = f["error"].as_str().unwrap();
    assert!(
        e.contains("gc: its process ended on signal 11 (SIGSEGV: a crash) before it reported"),
        "{e}"
    );
    assert_eq!(
        (f["final"].clone(), f.get("lost")),
        (json!(false), None),
        "a crash spends its attempt"
    );
    // The loop goes on: the next claim wants a pool job again, and gets one.
    h.give(job(43, "render", "x86_64", json!({ "ring": "edge" }), GEN2));
    h.advance(31);
    h.until(&mut d, "the next job's report", |h| {
        !h.pool.completes_of(43).is_empty()
    });
}

#[test]
fn a_failure_the_job_reports_is_the_pools_word_for_it_and_never_needs_a_native_host() {
    let h = H::new();
    let mut d = h.dispatcher();
    h.launch.set(
        44,
        r#"printf '%s' '{"ok":false,"fail":{"error":"health check of rc/aarch64 failed (see the health event)","final":false,"needs_native":true,"duration_ms":9}}' > "$JOB_DIR/result.json""#,
    );
    h.give(job(
        44,
        "health",
        "aarch64",
        json!({ "ring": "rc", "arch": "aarch64" }),
        GEN,
    ));
    h.until(&mut d, "the failure's report", |h| {
        !h.pool.fails_of(44).is_empty()
    });
    let f = &h.pool.fails_of(44)[0];
    assert_eq!(
        f["error"],
        "health check of rc/aarch64 failed (see the health event)"
    );
    assert_eq!(
        (
            f["final"].clone(),
            f["needs_native"].clone(),
            f["duration_ms"].clone()
        ),
        (json!(false), json!(false), json!(9))
    );
    assert!(h.leases().is_empty());
}

#[test]
fn a_sync_runs_while_every_build_unit_and_every_other_unit_holds_model_work() {
    // Five units, one kept for pool jobs: two drafts (model builds, two units each) hold the other four.
    let h = H::new();
    h.units(5);
    let mut d = h.dispatcher();
    for (n, id) in [(0, 60), (1, 61)] {
        h.give(task(
            id,
            "build",
            "felix",
            "draft:felix",
            "community",
            json!({}),
            &gen_of(n),
        ));
    }
    h.ticks(&mut d, 6);
    assert!(h.engine.has(60, &gen_of(0)) && h.engine.has(61, &gen_of(1)));
    // Every task unit held: the claim wants the pool jobs' unit only.
    h.advance(31);
    d.tick();
    let c = h.pool.last_claim();
    assert_eq!(c["want"], 1);
    assert!(c.get("offer").is_none(), "no task unit offered: {c}");
    assert!(c["kinds"].as_array().unwrap().contains(&json!("sync")));
    // The pool hands it a sync: it runs, beside the model work.
    let pid = h.out("sync.pid");
    h.launch
        .set(62, &format!("echo $$ > {}; sleep 600", pid.display()));
    h.give(job(
        62,
        "sync",
        "x86_64",
        json!({ "arch": "x86_64", "sources": "[]" }),
        &gen_of(2),
    ));
    h.advance(31);
    h.until(&mut d, "the sync started", |_| alive(&pid));
    assert_eq!(h.leases().len(), 3);
    // Every unit held, the pool jobs' too: want 0, and none of the pool's kinds (one job at a time).
    h.advance(31);
    h.ticks(&mut d, 1);
    let c = h.pool.last_claim();
    assert_eq!(c["want"], 0);
    assert!(!c["kinds"].as_array().unwrap().contains(&json!("sync")));
    d.kill_jobs();
    assert!(gone(&pid));
}

#[test]
fn a_job_holds_the_job_unit_never_a_tasks_and_a_second_job_handed_meanwhile_is_given_back() {
    // The minimum host (design v2 §7.3): 3 units, one build and the job unit. A sync leased first
    // holds the job unit; the build still starts beside it, whichever came first.
    let h = H::new();
    h.units(3);
    let mut d = h.dispatcher();
    let pid = h.out("sync-min.pid");
    h.launch
        .set(64, &format!("echo $$ > {}; sleep 600", pid.display()));
    h.give(job(
        64,
        "sync",
        "x86_64",
        json!({ "arch": "x86_64", "sources": "[]" }),
        &gen_of(0),
    ));
    h.until(&mut d, "the sync started", |_| alive(&pid));
    // The claim offers a build's two units, and none of the pool's kinds (one job at a time).
    h.advance(31);
    d.tick();
    let c = h.pool.last_claim();
    assert_eq!(c["want"], 1);
    assert!(c.get("offer").is_none(), "every task unit offered: {c}");
    assert!(!c["kinds"].as_array().unwrap().contains(&json!("render")));
    // A second job handed anyway (a stale answer, a pool that did not read `kinds`): given back with
    // its attempt, never started — the jobs share one work directory.
    let second = h.out("render-66.started");
    h.launch
        .set(66, &format!("touch {}; {JOB_DONE}", second.display()));
    h.give(job(
        66,
        "render",
        "x86_64",
        json!({ "ring": "edge", "arch": "x86_64" }),
        &gen_of(1),
    ));
    h.advance(31);
    h.ticks(&mut d, 2);
    let f = h.pool.fails_of(66);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0]["lost"], true);
    assert!(h.leases().iter().all(|l| l.task.id != 66));
    std::thread::sleep(Duration::from_millis(200));
    assert!(!second.exists(), "the second job never ran");
    // The build: started beside the sync.
    h.give(community(65, &gen_of(2)));
    h.advance(31);
    h.ticks(&mut d, 4);
    assert!(h.pool.fails_of(65).is_empty(), "{:?}", h.pool.fails_of(65));
    assert!(
        h.engine.has(65, &gen_of(2)),
        "the build runs beside the sync"
    );
    let mut held: Vec<(u64, u32)> = h.leases().iter().map(|l| (l.task.id, l.units)).collect();
    held.sort_unstable();
    assert_eq!(held, [(64, 1), (65, 2)]);
    assert!(alive(&pid), "the sync goes on");
    // Every unit held now: want 0.
    h.advance(31);
    d.tick();
    assert_eq!(h.pool.last_claim()["want"], 0);
    d.kill_jobs();
    assert!(gone(&pid));
}

#[test]
fn a_health_check_gets_the_shims_context_on_a_lane_of_its_ring_and_one_without_such_a_lane_is_given_back(
) {
    let h = H::new();
    emulated_lanes(&h);
    let mut d = h.dispatcher();
    let (env, ctx) = (h.out("env-50"), h.out("helper-50.json"));
    h.launch.set(
        50,
        &format!(
            "env > {}; cp \"$JOB_DIR/helper.json\" {}; {JOB_DONE}",
            env.display(),
            ctx.display()
        ),
    );
    // The x86_64 ring's health check on the Studio's emulated x86_64 lane: no preference, no wait.
    h.give(job(
        50,
        "health",
        "x86_64",
        json!({ "ring": "rc", "arch": "x86_64" }),
        GEN,
    ));
    h.until(&mut d, "the health check's report", |h| {
        !h.pool.completes_of(50).is_empty()
    });
    let c: shim::Context = serde_json::from_slice(&std::fs::read(&ctx).unwrap()).unwrap();
    assert_eq!((c.task, c.gen.as_str(), c.host.as_str()), (50, GEN, HOST));
    assert_eq!(c.arches, ["aarch64", "x86_64"]);
    assert_eq!(c.images, [IMAGE], "the release's pins (tests/images.env)");
    assert_eq!(c.scratch, h.tdir(50, GEN).join("tmp"));
    assert_eq!(
        (c.units, c.unit_cpus, c.unit_mem_gb),
        (1, 1, 2),
        "the job's unit"
    );
    assert_eq!(
        (c.worker_image.as_str(), c.engine.as_path()),
        (WORKER, Path::new("/usr/bin/docker"))
    );
    assert!(spec::Subnets::parse(&c.subnets)
        .unwrap()
        .slot(c.slot)
        .is_some());
    let env = std::fs::read_to_string(&env).unwrap();
    assert!(env.lines().any(|l| l
        == format!(
            "OMARCHY_TASK_RUN={}",
            h.tdir(50, GEN).join("helper.json").display()
        )));
    // A host with no x86_64 lane: the same check, and a promotion that checks both rings' arches,
    // are given back with their attempts, never started.
    h.units(11);
    let mut d = h.dispatcher();
    h.give(job(
        51,
        "health",
        "x86_64",
        json!({ "ring": "rc", "arch": "x86_64" }),
        GEN2,
    ));
    h.advance(31);
    h.ticks(&mut d, 2);
    h.give(job(
        52,
        "promote",
        "x86_64",
        json!({ "from": "rc", "to": "stable" }),
        GEN2,
    ));
    h.advance(31);
    h.ticks(&mut d, 2);
    for id in [51, 52] {
        let f = h.pool.fails_of(id);
        assert_eq!(f.len(), 1, "{id}: {f:?}");
        assert_eq!(f[0]["lost"], true);
        assert!(
            f[0]["error"]
                .as_str()
                .unwrap()
                .contains("runs no lane of it"),
            "{f:?}"
        );
    }
    assert!(h.leases().is_empty());
}

#[test]
fn an_enqueue_reads_its_recipes_through_the_shim_on_the_hosts_own_arch() {
    // Its PKGBUILD reader sources recipes — package code — so it is a helper through the spec
    // (reconcile.rs), on the dispatcher's native arch: an x86_64 row's enqueue on this aarch64-only
    // host gets the shim's context, never a refusal for want of one.
    let h = H::new();
    let mut d = h.dispatcher();
    let (env, ctx) = (h.out("env-80"), h.out("helper-80.json"));
    h.launch.set(
        80,
        &format!(
            "env > {}; cp \"$JOB_DIR/helper.json\" {}; {JOB_DONE}",
            env.display(),
            ctx.display()
        ),
    );
    h.give(job(80, "enqueue", "x86_64", json!({}), GEN));
    h.until(&mut d, "the enqueue's report", |h| {
        !h.pool.completes_of(80).is_empty()
    });
    let c: shim::Context = serde_json::from_slice(&std::fs::read(&ctx).unwrap()).unwrap();
    assert_eq!((c.task, c.gen.as_str()), (80, GEN));
    assert_eq!(c.arches, ["aarch64"]);
    assert_eq!(c.scratch, h.tdir(80, GEN).join("tmp"));
    let env = std::fs::read_to_string(&env).unwrap();
    assert!(env.lines().any(|l| l
        == format!(
            "OMARCHY_TASK_RUN={}",
            h.tdir(80, GEN).join("helper.json").display()
        )));
    assert!(env.lines().any(|l| l
        == format!(
            "RUNTIME={}",
            h.work.join("state/bin/omarchy-task-run").display()
        )));
}

#[test]
fn a_job_does_not_outlive_its_dispatcher_one_running_is_lost_and_one_that_ended_is_reported() {
    let h = H::new();
    let mut d = h.dispatcher();
    let (hung, ended) = (h.out("hung.pid"), h.out("ended.pid"));
    h.launch
        .set(70, &format!("echo $$ > {}; sleep 600", hung.display()));
    h.give(job(70, "verify", "x86_64", json!({}), GEN));
    h.until(&mut d, "the job started", |_| alive(&hung));
    // The dispatcher exits (a restart order, a release): its jobs' process groups go with it.
    d.kill_jobs();
    assert!(gone(&hung));
    let mut d = h.dispatcher();
    let f = h.pool.fails_of(70);
    assert_eq!(f.len(), 0, "reported once its kill is seen");
    h.ticks(&mut d, 1);
    let f = h.pool.fails_of(70);
    assert_eq!((f.len(), f[0]["lost"].clone()), (1, json!(true)), "{f:?}");
    assert!(f[0]["error"]
        .as_str()
        .unwrap()
        .contains("ended with the dispatcher"));
    // One that had written its result when its dispatcher went: reported from it.
    h.launch.set(
        71,
        &format!("{JOB_DONE}; echo $$ > {}; sleep 600", ended.display()),
    );
    h.give(job(71, "render", "x86_64", json!({ "ring": "edge" }), GEN2));
    h.advance(31);
    h.until(&mut d, "the job returned", |_| alive(&ended));
    d.kill_jobs();
    let mut d = h.dispatcher();
    h.ticks(&mut d, 1);
    assert_eq!(h.pool.completes_of(71).len(), 1);
    assert!(h.leases().is_empty());
}

#[test]
fn a_stop_at_a_heartbeat_kills_a_jobs_process_group_and_a_renewed_token_reaches_the_job() {
    let h = H::new();
    let mut d = h.dispatcher();
    let pid = h.out("stop.pid");
    h.launch.set(
        80,
        &format!("sleep 600 & echo $! > {}; wait", pid.display()),
    );
    h.pool
        .beats
        .lock()
        .unwrap()
        .insert(80, BeatMode::Renew("omj.fresh-80".into()));
    h.give(job(80, "relayout", "x86_64", json!({}), GEN));
    h.until(&mut d, "the job started", |_| alive(&pid));
    for _ in 0..12 {
        d.tick();
        h.advance(30);
    }
    assert_eq!(
        std::fs::read_to_string(h.tdir(80, GEN).join("token")).unwrap(),
        "omj.fresh-80",
        "the job's next script and its next page take the renewed token"
    );
    h.pool
        .beats
        .lock()
        .unwrap()
        .insert(80, BeatMode::Stop("stopping".into()));
    for _ in 0..12 {
        d.tick();
        h.advance(30);
    }
    assert!(gone(&pid), "its process group killed");
    let f = h.pool.fails_of(80);
    assert_eq!(f.len(), 1);
    assert!(f[0]["error"]
        .as_str()
        .unwrap()
        .contains("was stopped by the pool"));
    assert!(h.leases().is_empty());
}
