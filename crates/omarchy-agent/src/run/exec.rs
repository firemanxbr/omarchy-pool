//! Child processes with a deadline: no call the loop makes blocks longer than one engine
//! call with a timeout (design v2 §16.1). A child that outlives its deadline is killed.

use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// What a finished child said. `code` is `None` when a signal ended it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Output {
    /// The file name of the binary that ran (`docker`, `docker-compose`).
    pub program: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

/// How much of a child's output is kept; the rest is read and dropped.
const MAX_OUTPUT: u64 = 1 << 20;

fn drain(r: Option<impl Read + Send + 'static>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(r) = r {
            let mut r = r.take(MAX_OUTPUT);
            let _ = r.read_to_end(&mut out);
            // Keep reading past the cap so the child never blocks on a full pipe.
            let _ = std::io::copy(&mut r.into_inner(), &mut std::io::sink());
        }
        String::from_utf8_lossy(&out).into_owned()
    })
}

/// The file name of `cmd`'s binary.
fn program(cmd: &Command) -> String {
    let p = Path::new(cmd.get_program());
    p.file_name()
        .unwrap_or(p.as_os_str())
        .to_string_lossy()
        .into_owned()
}

/// Starts `cmd`; the error names the binary and why it could not be started.
fn spawn(cmd: &mut Command) -> Result<Child, String> {
    cmd.spawn().map_err(|e| {
        format!(
            "could not start {}: {e}",
            Path::new(cmd.get_program()).display()
        )
    })
}

/// Runs `cmd` to its end or its deadline. `Err` when it could not start or was killed.
pub(crate) fn run(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn(&mut cmd)?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let status = wait(&mut child, timeout);
    let (stdout, stderr) = (
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    );
    match status {
        Some(s) => Ok(Output {
            program: program(&cmd),
            code: s.code(),
            stdout,
            stderr,
        }),
        None => Err(format!(
            "{}: no answer within {} s",
            program(&cmd),
            timeout.as_secs()
        )),
    }
}

/// Waits for `child` until `timeout`; kills it and returns `None` past that.
fn wait(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return Some(s),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// A long child (a pull, a stop) started now and polled on later ticks.
#[derive(Debug)]
pub(crate) struct Background {
    child: Child,
    program: String,
    started: Instant,
    limit: Duration,
    stderr: Option<thread::JoinHandle<String>>,
}

/// Where a background child is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Progress {
    Running,
    Done(Output),
    /// Killed at its limit.
    TimedOut,
}

impl Background {
    pub fn start(mut cmd: Command, limit: Duration) -> Result<Self, String> {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = spawn(&mut cmd)?;
        let stderr = Some(drain(child.stderr.take()));
        Ok(Background {
            child,
            program: program(&cmd),
            started: Instant::now(),
            limit,
            stderr,
        })
    }

    pub fn poll(&mut self) -> Progress {
        match self.child.try_wait() {
            Ok(Some(s)) => Progress::Done(Output {
                program: self.program.clone(),
                code: s.code(),
                stdout: String::new(),
                stderr: self
                    .stderr
                    .take()
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default(),
            }),
            Ok(None) if self.started.elapsed() < self.limit => Progress::Running,
            _ => {
                let _ = self.child.kill();
                let _ = self.child.wait();
                Progress::TimedOut
            }
        }
    }
}

impl Drop for Background {
    fn drop(&mut self) {
        // A child nobody polls any more (a preempted pull) is ended, never left behind.
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{run, Background, Progress};
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn a_child_past_its_deadline_is_killed_and_said_so() {
        let mut c = Command::new("sh");
        c.args(["-c", "echo out; echo err >&2; exit 3"]);
        let o = run(c, Duration::from_secs(10)).unwrap();
        assert_eq!(
            (o.code, o.stdout.as_str(), o.stderr.as_str()),
            (Some(3), "out\n", "err\n")
        );
        let mut c = Command::new("sleep");
        c.arg("30");
        let e = run(c, Duration::from_millis(200)).unwrap_err();
        assert!(e.contains("no answer"), "{e}");
    }

    #[test]
    fn a_background_child_is_polled_and_killed_at_its_limit() {
        let mut c = Command::new("sleep");
        c.arg("30");
        let mut b = Background::start(c, Duration::from_millis(100)).unwrap();
        assert_eq!(b.poll(), Progress::Running);
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(b.poll(), Progress::TimedOut);
        let mut c = Command::new("sh");
        c.args(["-c", "echo nope >&2; exit 1"]);
        let mut b = Background::start(c, Duration::from_secs(10)).unwrap();
        let done = loop {
            match b.poll() {
                Progress::Running => std::thread::sleep(Duration::from_millis(10)),
                p => break p,
            }
        };
        let Progress::Done(o) = done else { panic!() };
        assert_eq!((o.code, o.stderr.as_str()), (Some(1), "nope\n"));
    }
}
