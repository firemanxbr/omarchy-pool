//! The egress probe (#317, design v2 §9.4, §13.3): a probe task must fail to reach the
//! cloud metadata address, the default gateway and the host's LAN address, and must reach
//! a public address. Anything it reaches that it must not — a connection made, or one
//! refused, which is an answer from the target too — fails the install; so does a public
//! address it cannot reach, or a target it gave no answer for.
//!
//! The probe container runs on its own network carved from the task subnets (their last
//! /28), the network a task with a signed exception gets, which is what prep-root.sh's
//! DOCKER-USER rules guard on a rootful host. Seam for the egress sidecar's issue: once
//! the worker image has the sidecar, the probe runs on an internal network behind it, as
//! every task will, and must reach the public address through it.
//!
//! Until then a rootless host is refused here: rootless podman's network (pasta) carries
//! the host's own address into the task's namespace, so the LAN target answers `refused`
//! from inside it, and prep-root.sh's DOCKER-USER rules are rootful only. Seam for the
//! egress sidecar's issue too: a rootless host passes once its tasks egress through it.

use std::net::Ipv4Addr;

use super::engine::Docker;
use super::net::Cidr;

/// What the probe task tries, as `name host port`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Targets {
    pub forbidden: Vec<(&'static str, String, u16)>,
    pub public: (String, u16),
}

impl Targets {
    /// The host's own: the metadata address, its default gateway and LAN address when it
    /// has them, and GitHub (which every task needs anyway).
    pub fn of_host(gateway: Option<Ipv4Addr>, lan: Option<Ipv4Addr>) -> Self {
        let mut forbidden = vec![("metadata", "169.254.169.254".to_owned(), 80)];
        if let Some(g) = gateway {
            forbidden.push(("gateway", g.to_string(), 53));
        }
        if let Some(l) = lan {
            forbidden.push(("lan", l.to_string(), 22));
        }
        Targets {
            forbidden,
            public: ("github.com".to_owned(), 443),
        }
    }

    fn args(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (n, h, p) in &self.forbidden {
            out.extend([(*n).to_owned(), h.clone(), p.to_string()]);
        }
        out.extend([
            "public".to_owned(),
            self.public.0.clone(),
            self.public.1.to_string(),
        ]);
        out
    }
}

/// The probe task's script: bash's `/dev/tcp` where there is bash (the Arch build image),
/// else `nc -z`. Each target prints `egress <name> open|refused|blocked`. busybox's and
/// OpenBSD's `nc -z` print nothing for a refused connection and return at once, while a
/// target that does not answer takes the whole `-w 4`: a quiet failure in under 3 s is a
/// refusal.
pub(crate) const SCRIPT: &str = r#"reach() {
  if command -v bash >/dev/null 2>&1; then out=$(timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$2" "$3" 2>&1); rc=$?
  else s=$(date +%s); out=$(nc -z -w 4 "$2" "$3" 2>&1 </dev/null); rc=$?
    if [ "$rc" != 0 ] && [ -z "$out" ] && [ $(( $(date +%s) - s )) -lt 3 ]; then out=refused; fi; fi
  if [ "$rc" = 0 ]; then r=open; else case "$out" in *efused*) r=refused ;; *) r=blocked ;; esac; fi
  echo "egress $1 $r"
}
while [ $# -ge 3 ]; do reach "$1" "$2" "$3"; shift 3; done
"#;

const LABEL: &str = "org.omarchy-pool.probe=egress";

/// Removes every probe container and network, this run's or one an earlier run left
/// behind (interrupted, or its engine did not answer): a leftover network would hold the
/// probe's /28 and refuse every later install. Uninstall calls it too.
pub(crate) fn sweep(docker: &Docker) -> Result<(), String> {
    let filter = format!("label={LABEL}");
    let ids = docker.run(&["ps", "-aq", "--no-trunc", "--filter", &filter])?;
    let ids: Vec<&str> = ids.split_whitespace().collect();
    if !ids.is_empty() {
        let mut args = vec!["rm", "-f"];
        args.extend(&ids);
        docker.run(&args)?;
    }
    for n in docker
        .run(&["network", "ls", "-q", "--filter", &filter])?
        .split_whitespace()
    {
        docker.run(&["network", "rm", n])?;
    }
    Ok(())
}

/// Runs the probe task on its own network in `subnet`, and removes both: a network it
/// could not remove is reported, not left behind silently.
pub(crate) fn probe(
    docker: &Docker,
    image: &str,
    subnet: Cidr,
    t: &Targets,
) -> Result<String, String> {
    let net = format!("omarchy-egress-probe-{}", std::process::id());
    let label = LABEL;
    sweep(docker).map_err(|e| format!("an earlier egress probe's leftovers: {e}"))?;
    docker
        .run(&[
            "network",
            "create",
            "--subnet",
            &subnet.to_string(),
            "--label",
            label,
            &net,
        ])
        .map_err(|e| format!("the egress probe's network {subnet}: {e}"))?;
    let mut args: Vec<String> = [
        "run",
        "--rm",
        "--network",
        &net,
        "--label",
        label,
        "--entrypoint",
        "sh",
        image,
        "-c",
        SCRIPT,
        "sh",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    args.extend(t.args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = docker
        .run(&refs)
        .map_err(|e| format!("the egress probe task: {e}"));
    let removed = sweep(docker).map_err(|e| {
        format!(
            "the egress probe's network {net} was not removed ({e}); the next preflight removes it"
        )
    });
    let out = out?;
    removed.map(|()| out)
}

/// What the probe's output says: the blockers, none when only the public address answered.
pub(crate) fn verdict(out: &str, t: &Targets) -> Vec<String> {
    let seen = |name: &str| {
        out.lines()
            .find_map(|l| {
                l.strip_prefix("egress ")?
                    .strip_prefix(name)?
                    .strip_prefix(' ')
            })
            .map(str::trim)
    };
    let mut blockers = Vec::new();
    for (name, host, port) in &t.forbidden {
        let what = match *name {
            "metadata" => "the cloud metadata address",
            "gateway" => "the default gateway",
            _ => "the host's LAN address",
        };
        match seen(name) {
            Some("blocked") => {}
            Some(r) => blockers.push(format!(
                "egress: a task reaches {what} {host} (port {port}: {r}); only public addresses may be reachable (prep-root.sh's DOCKER-USER rules, or the egress sidecar)"
            )),
            None => blockers.push(format!("egress: the probe task gave no answer for {what} {host}")),
        }
    }
    let (host, port) = &t.public;
    match seen("public") {
        Some("open") => {}
        Some(r) => blockers.push(format!(
            "egress: a task cannot reach the public address {host}:{port} ({r}); tasks need public egress"
        )),
        None => blockers.push(format!("egress: the probe task gave no answer for {host}:{port}")),
    }
    blockers
}
