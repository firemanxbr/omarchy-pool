//! What this machine uses, as the claim reports it: an average the worker
//! keeps of the host's CPU, its memory and the work directory's disk,
//! sampled on its own clock — once a minute, over the last hour — so the
//! Workers page can say how loaded each machine is with no metrics pipeline
//! and no extra write (the claim already touches the worker's row). Linux
//! only (`/proc`, `df`); anywhere else the claim carries no usage and the
//! page shows a dash.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// One sample a minute; the average covers the last sixty.
const SAMPLE_EVERY: Duration = Duration::from_secs(60);
const WINDOW: usize = 60;

#[derive(Clone, Copy)]
struct Sample {
    cpu: f64,
    ram: f64,
    disk: f64,
}

#[derive(Default)]
struct State {
    samples: VecDeque<Sample>,
    /// (busy, total) jiffies at the previous read: the CPU share is a delta.
    cpu_prev: Option<(u64, u64)>,
    cores: u64,
    ram_gb: f64,
    disk_gb: f64,
}

/// The sampler: a thread that reads the machine, and a report for the claim.
#[derive(Clone)]
pub struct Sampler {
    state: Arc<Mutex<State>>,
}

impl Sampler {
    /// Starts sampling the machine `work_dir` lives on; the first CPU value
    /// needs two reads, so the first report comes a minute in.
    pub fn start(work_dir: PathBuf) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let s = Self { state };
        let me = s.clone();
        std::thread::Builder::new()
            .name("usage".into())
            .spawn(move || loop {
                me.sample(&work_dir);
                std::thread::sleep(SAMPLE_EVERY);
            })
            .ok();
        s
    }

    fn sample(&self, work_dir: &Path) {
        let Ok(mut st) = self.state.lock() else {
            return;
        };
        let cpu = cpu_jiffies().and_then(|(busy, total, cores)| {
            st.cores = cores;
            let share = st.cpu_prev.and_then(|(b0, t0)| {
                let (db, dt) = (busy.saturating_sub(b0), total.saturating_sub(t0));
                (dt > 0).then(|| pct(db, dt))
            });
            st.cpu_prev = Some((busy, total));
            share
        });
        let ram = meminfo().map(|(total_kb, avail_kb)| {
            st.ram_gb = gb(total_kb);
            pct(total_kb.saturating_sub(avail_kb), total_kb)
        });
        let disk = df(work_dir).map(|(blocks_kb, used_kb, avail_kb)| {
            st.disk_gb = gb(blocks_kb);
            pct(used_kb, used_kb + avail_kb)
        });
        if let (Some(cpu), Some(ram), Some(disk)) = (cpu, ram, disk) {
            if st.samples.len() >= WINDOW {
                st.samples.pop_front();
            }
            st.samples.push_back(Sample { cpu, ram, disk });
        }
    }

    /// The average so far, or `Null` before the first full sample.
    pub fn report(&self) -> serde_json::Value {
        let Ok(st) = self.state.lock() else {
            return serde_json::Value::Null;
        };
        if st.samples.is_empty() {
            return serde_json::Value::Null;
        }
        let n = st.samples.len();
        let mean = |f: fn(&Sample) -> f64| {
            let sum: f64 = st.samples.iter().map(f).sum();
            #[allow(clippy::cast_precision_loss)]
            let m = sum / n as f64;
            (m * 10.0).round() / 10.0
        };
        serde_json::json!({
            "cpu": mean(|s| s.cpu), "ram": mean(|s| s.ram), "disk": mean(|s| s.disk),
            "cores": st.cores, "ram_gb": st.ram_gb, "disk_gb": st.disk_gb, "minutes": n,
        })
    }
}

#[allow(clippy::cast_precision_loss)]
fn pct(part: u64, whole: u64) -> f64 {
    if whole == 0 {
        0.0
    } else {
        100.0 * part as f64 / whole as f64
    }
}

#[allow(clippy::cast_precision_loss)]
fn gb(kb: u64) -> f64 {
    (kb as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

/// `/proc/stat`: (busy, total) jiffies of the whole machine and the number of cores.
fn cpu_jiffies() -> Option<(u64, u64, u64)> {
    parse_stat(&std::fs::read_to_string("/proc/stat").ok()?)
}

fn parse_stat(text: &str) -> Option<(u64, u64, u64)> {
    let mut lines = text.lines();
    let first = lines.next()?.strip_prefix("cpu ")?;
    let v: Vec<u64> = first
        .split_whitespace()
        .filter_map(|x| x.parse().ok())
        .collect();
    if v.len() < 5 {
        return None;
    }
    // user nice system idle iowait irq softirq steal: idle and iowait are the rest.
    let idle = v[3] + v.get(4).copied().unwrap_or(0);
    let total: u64 = v.iter().take(8).sum();
    let cores = lines.filter(|l| l.starts_with("cpu")).count() as u64;
    Some((total - idle, total, cores.max(1)))
}

/// `/proc/meminfo`: (`MemTotal`, `MemAvailable`) in kB.
fn meminfo() -> Option<(u64, u64)> {
    parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

fn parse_meminfo(text: &str) -> Option<(u64, u64)> {
    let field = |name: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|r| r.trim_start_matches(':').split_whitespace().next())
            .and_then(|n| n.parse::<u64>().ok())
    };
    Some((field("MemTotal")?, field("MemAvailable")?))
}

/// `df -kP <dir>`: (size, used, available) in kB of the filesystem the work directory is on.
fn df(dir: &Path) -> Option<(u64, u64, u64)> {
    let out = Command::new("df").arg("-kP").arg(dir).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let last = text.lines().last()?;
    let f: Vec<&str> = last.split_whitespace().collect();
    if f.len() < 4 {
        return None;
    }
    Some((f[1].parse().ok()?, f[2].parse().ok()?, f[3].parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_is_the_mean_of_what_was_sampled() {
        let s = Sampler {
            state: Arc::new(Mutex::new(State {
                samples: [(10.0, 40.0, 60.0), (30.0, 50.0, 62.0)]
                    .into_iter()
                    .map(|(cpu, ram, disk)| Sample { cpu, ram, disk })
                    .collect(),
                cpu_prev: None,
                cores: 8,
                ram_gb: 16.0,
                disk_gb: 200.0,
            })),
        };
        let r = s.report();
        assert_eq!(r["cpu"], 20.0);
        assert_eq!(r["ram"], 45.0);
        assert_eq!(r["disk"], 61.0);
        assert_eq!(r["cores"], 8);
        assert_eq!(r["minutes"], 2);
    }

    #[test]
    fn nothing_sampled_is_no_report() {
        let s = Sampler {
            state: Arc::new(Mutex::new(State::default())),
        };
        assert!(s.report().is_null());
    }

    #[test]
    fn proc_files_are_read_the_way_top_reads_them() {
        let stat = "cpu  100 0 50 800 50 10 10 0 0 0\ncpu0 1 0 0 0 0 0 0 0\ncpu1 1 0 0 0 0 0 0 0\nintr 5\n";
        let (busy, total, cores) = parse_stat(stat).unwrap();
        assert_eq!((busy, total, cores), (170, 1020, 2));
        assert_eq!(
            parse_meminfo("MemTotal:       16384 kB\nMemFree:  1 kB\nMemAvailable:   8192 kB\n"),
            Some((16384, 8192))
        );
        assert!(parse_stat("nothing").is_none());
        assert!(parse_meminfo("MemTotal: 1 kB").is_none());
    }

    #[test]
    fn a_share_of_nothing_is_zero() {
        assert!(pct(3, 0).abs() < f64::EPSILON);
        assert!((pct(1, 4) - 25.0).abs() < f64::EPSILON);
        assert!((gb(1_048_576) - 1.0).abs() < f64::EPSILON);
    }
}
