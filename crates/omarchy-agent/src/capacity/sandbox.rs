//! A sandboxed runtime for community tasks (design v2 §10.4, §19.3; D43; #330): gVisor
//! (`runsc`) or Kata Containers, on a host whose engine has one. The dispatcher runs a
//! community task on its native lane under it (`--runtime <name>`), so a container escape
//! of a contributor's recipe lands in the sandbox's own kernel — gVisor's, or Kata's VM —
//! and not on the host, whatever the isolation level (§19.3) says an escape from the
//! engine's own runtime lands as. Detected, not configured, as an emulated lane is:
//!
//! 1. the envelope's `sandbox` (design v2 §12): absent or `"auto"` tries what the engine
//!    lists, `"off"` uses none and runs nothing for it, a runtime's name only that one;
//! 2. the engine's runtimes (`docker info`'s `Runtimes`): one whose name, path or shim type
//!    says `runsc` is gVisor, `kata` Kata Containers; gVisor's first. podman lists every
//!    runtime its containers.conf knows, installed or not, so in `auto` one whose absolute
//!    path is not on this machine is passed over (on a Mac the engine's files are its VM's,
//!    which the agent does not see: nothing is passed over there);
//! 3. the smoke run through the engine ([`Run`]): the release's build image, by digest,
//!    under `--runtime <name>`, prints its kernel's release (`uname -r`), which must not be
//!    the engine's own — a runtime on the host's kernel is no sandbox, and docker's CLI on
//!    podman, whose API does not pass `--runtime` on (podman 4.9 runs its default runtime
//!    instead), shows exactly that — then answers `pacman --version`.
//!
//! The first that passes is the host's sandbox (`run/capacity.json`'s `sandbox`, which the
//! host report carries to the host page). One the envelope names that is not there or
//! fails, and one installed here that fails its smoke run, are said with why
//! (`sandbox_held`); a host with none says `sandbox: null`, and its community tasks run on
//! the engine's own runtime as before (D43: on hosts that have it).
//!
//! **The native lane only.** An emulated lane runs its architecture through the host
//! kernel's binfmt handler (§7.5), which a sandbox's own kernel does not have: a community
//! task on an emulated lane runs on the engine's own runtime, and the host page says so.
//! Its sidecars run the signed worker image on the engine's own runtime too: no recipe code
//! runs in them.

use std::path::Path;

use serde::Serialize;

/// Which sandbox a runtime is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// gVisor's `runsc`: an application kernel in user space between the task and the host's.
    Gvisor,
    /// Kata Containers: each container in a lightweight VM with its own kernel.
    Kata,
}

impl Kind {
    /// As install's notes and the host page say it.
    pub fn words(self) -> &'static str {
        match self {
            Kind::Gvisor => "gVisor",
            Kind::Kata => "Kata Containers",
        }
    }
}

/// The host's sandbox: the engine's name for the runtime (what `--runtime` takes) and which
/// sandbox it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Sandbox {
    pub runtime: String,
    pub kind: Kind,
}

/// One runtime the engine lists (`docker info`'s `Runtimes`): its name, its `path` and a
/// containerd shim's `runtimeType`, each empty when the engine does not say it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Listed {
    pub name: String,
    pub path: String,
    pub shim: String,
}

/// The envelope's `sandbox` (design v2 §12).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Setting {
    /// Absent or `"auto"`: the first runtime the engine lists that passes the smoke run.
    #[default]
    Auto,
    /// `"off"`: none, and nothing is run for one.
    Off,
    /// A runtime's name: that one only.
    Named(String),
}

impl Setting {
    /// The envelope's value: `"auto"`, `"off"`, or a runtime's name in the grammar
    /// [`runtime_ok`] reads.
    pub fn parse(v: Option<&str>) -> Result<Self, String> {
        match v {
            None | Some("auto") => Ok(Self::Auto),
            Some("off") => Ok(Self::Off),
            Some(n) if runtime_ok(n) => Ok(Self::Named(n.to_owned())),
            Some(n) => Err(format!(
                "agent.toml: [envelope] sandbox = {n:?} is not \"auto\", \"off\" or a runtime's name \
                 (lowercase letters, digits, '.', '_' and '-')"
            )),
        }
    }
}

/// A runtime's name as it reaches the engine's argv here and in the dispatcher's task
/// spec: `[a-z0-9][a-z0-9._-]{0,63}`.
pub fn runtime_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|&c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// Which sandbox a listed runtime is, by its name, its path's file name or its shim type.
pub fn kind_of(l: &Listed) -> Option<Kind> {
    let file = Path::new(&l.path)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    let says = |w: &str| {
        [l.name.as_str(), file.as_str(), l.shim.as_str()]
            .iter()
            .any(|s| s.to_ascii_lowercase().contains(w))
    };
    if says("runsc") || says("gvisor") {
        Some(Kind::Gvisor)
    } else if says("kata") {
        Some(Kind::Kata)
    } else {
        None
    }
}

/// The smoke run of a sandbox (design v2 §15's driver runs it with the engine's CLI:
/// [`super::probe::Probe`]; the tests fake it).
pub trait Run {
    /// Under `--runtime <runtime>`, the build image by digest: the kernel release its
    /// `uname -r` printed, once `pacman --version` answered too.
    fn sandbox(&self, runtime: &str, image: &str) -> Result<String, String>;
}

/// The smoke run's two containers, in order: their entrypoint, its arguments, and what it
/// must print. Each runs with `--network none`: a smoke run reaches nothing.
pub const STEPS: [(&str, &[&str], &str); 2] = [
    ("uname", &["-r"], ""),
    ("pacman", &["--version"], "Pacman v"),
];

/// What detection needs besides the engine's word: the envelope's, and whether the engine's
/// files are this machine's (not a Mac's VM), so a path podman lists can be looked for.
#[derive(Debug, Clone, Copy)]
pub struct Probe<'a> {
    pub setting: &'a Setting,
    pub local: bool,
}

/// What detection found: the sandbox, and why a runtime that could have been one is not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Found {
    pub on: Option<Sandbox>,
    pub held: Option<String>,
}

/// A held reason is cut here (the host page shows it whole; the pool keeps 300 characters).
const HELD_MAX: usize = 300;

/// The host's sandbox, from the runtimes the engine lists and its own kernel's release
/// (`docker info`'s `KernelVersion`), the build image by digest the smoke run starts, and
/// whether a path is on this machine.
pub fn detect(
    listed: &[Listed],
    kernel: &str,
    image: Option<&str>,
    p: &Probe<'_>,
    here: &dyn Fn(&Path) -> bool,
    run: &dyn Run,
) -> Found {
    let mut candidates: Vec<(&Listed, Kind)> = listed
        .iter()
        .filter(|l| runtime_ok(&l.name))
        .filter_map(|l| kind_of(l).map(|k| (l, k)))
        .collect();
    // gVisor first: it needs no virtualisation of the machine, so it is the one a VM has.
    candidates.sort_by_key(|(l, k)| (*k != Kind::Gvisor, l.name.clone()));
    let held = |why: String| Found {
        on: None,
        held: Some(why.chars().take(HELD_MAX).collect()),
    };
    match p.setting {
        Setting::Off => return Found::default(),
        Setting::Named(n) => {
            candidates.retain(|(l, _)| &l.name == n);
            if candidates.is_empty() {
                let listed = listed.iter().any(|l| &l.name == n);
                return held(if listed {
                    format!("the envelope names {n}: the engine lists it, but it is neither gVisor's runsc nor Kata Containers")
                } else {
                    format!("the envelope names {n}: the engine lists no such runtime")
                });
            }
        }
        Setting::Auto => candidates.retain(|(l, _)| {
            let path = Path::new(&l.path);
            !p.local || !path.is_absolute() || here(path)
        }),
    }
    if candidates.is_empty() {
        return Found::default();
    }
    let Some(image) = image.filter(|i| super::emulation::image_ok(i)) else {
        return held(format!(
            "{} not checked: no build image by digest to run in it (a release names one)",
            candidates[0].0.name
        ));
    };
    let kernel = kernel.trim();
    let mut failed = Vec::new();
    for (l, kind) in candidates {
        match run.sandbox(&l.name, image).map(|k| k.trim().to_owned()) {
            Ok(k) if kernel.is_empty() => failed.push(format!(
                "{}: the engine did not say its own kernel, so a sandbox's ({k}) cannot be told from it",
                l.name
            )),
            Ok(k) if k.is_empty() => {
                failed.push(format!("{}: its `uname -r` printed nothing", l.name));
            }
            Ok(k) if k != kernel => {
                return Found {
                    on: Some(Sandbox {
                        runtime: l.name.clone(),
                        kind,
                    }),
                    held: (!failed.is_empty())
                        .then(|| failed.join("; ").chars().take(HELD_MAX).collect()),
                };
            }
            Ok(k) => failed.push(format!(
                "{}: its container ran on the engine's own kernel ({k}), so it is no sandbox",
                l.name
            )),
            Err(e) => failed.push(format!(
                "{}: the smoke run failed: {}",
                l.name,
                e.chars().take(200).collect::<String>()
            )),
        }
    }
    held(failed.join("; "))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    const IMAGE: &str = "docker.io/library/archlinux@sha256:51dd3d24f7fba779e7c471caeee7804c50e8c134ad948e19685a1c83a42facc3";
    const HOST_KERNEL: &str = "6.8.0-1017-azure";

    /// A smoke run that prints each runtime's kernel, or fails it.
    struct FakeRun {
        kernels: Vec<(&'static str, Result<&'static str, &'static str>)>,
        asked: RefCell<Vec<(String, String)>>,
    }

    impl FakeRun {
        fn new(kernels: &[(&'static str, Result<&'static str, &'static str>)]) -> Self {
            FakeRun {
                kernels: kernels.to_vec(),
                asked: RefCell::new(Vec::new()),
            }
        }
        fn asked(&self) -> Vec<String> {
            self.asked.borrow().iter().map(|(r, _)| r.clone()).collect()
        }
    }

    impl Run for FakeRun {
        fn sandbox(&self, runtime: &str, image: &str) -> Result<String, String> {
            self.asked
                .borrow_mut()
                .push((runtime.to_owned(), image.to_owned()));
            match self.kernels.iter().find(|(r, _)| *r == runtime) {
                Some((_, Ok(k))) => Ok(format!("{k}\n")),
                Some((_, Err(e))) => Err((*e).to_owned()),
                None => Err(format!("unknown or invalid runtime name: {runtime}")),
            }
        }
    }

    fn listed(name: &str, path: &str, shim: &str) -> Listed {
        Listed {
            name: name.into(),
            path: path.into(),
            shim: shim.into(),
        }
    }

    /// Docker with gVisor registered (`runsc install`) beside its own runc.
    fn docker_with_runsc() -> Vec<Listed> {
        vec![
            listed("io.containerd.runc.v2", "runc", ""),
            listed("runc", "runc", ""),
            listed("runsc", "/usr/local/bin/runsc", ""),
        ]
    }

    /// What podman 4.9's Docker-compatible API lists: every runtime containers.conf knows.
    fn podman_lists() -> Vec<Listed> {
        [
            ("crun", "/usr/bin/crun"),
            ("kata", "/usr/bin/kata-runtime"),
            ("krun", "/usr/bin/krun"),
            ("runc", "/usr/bin/runc"),
            ("runsc", "/usr/bin/runsc"),
            ("youki", "/usr/local/bin/youki"),
        ]
        .iter()
        .map(|(n, p)| listed(n, p, ""))
        .collect()
    }

    fn find(listed: &[Listed], setting: &Setting, run: &FakeRun) -> Found {
        detect(
            listed,
            HOST_KERNEL,
            Some(IMAGE),
            &Probe {
                setting,
                local: true,
            },
            &|_| true,
            run,
        )
    }

    #[test]
    fn gvisor_registered_with_docker_is_the_sandbox_after_its_smoke_run() {
        let run = FakeRun::new(&[("runsc", Ok("4.19.0-gvisor"))]);
        let f = find(&docker_with_runsc(), &Setting::Auto, &run);
        assert_eq!(
            f,
            Found {
                on: Some(Sandbox {
                    runtime: "runsc".into(),
                    kind: Kind::Gvisor
                }),
                held: None
            }
        );
        assert_eq!(run.asked.borrow()[0], ("runsc".into(), IMAGE.into()));
        assert_eq!(
            serde_json::to_value(&f.on).unwrap(),
            serde_json::json!({"runtime": "runsc", "kind": "gvisor"})
        );
    }

    #[test]
    fn a_runtime_on_the_engines_own_kernel_is_no_sandbox() {
        // docker's CLI on podman: `--runtime runsc` is not passed on, podman's runc answers.
        let run = FakeRun::new(&[("runsc", Ok(HOST_KERNEL))]);
        let f = find(&docker_with_runsc(), &Setting::Auto, &run);
        assert_eq!(f.on, None);
        assert_eq!(
            f.held.unwrap(),
            "runsc: its container ran on the engine's own kernel (6.8.0-1017-azure), so it is no sandbox"
        );
        // An engine that does not say its kernel: nothing to tell a sandbox's from.
        let f = detect(
            &docker_with_runsc(),
            " ",
            Some(IMAGE),
            &Probe {
                setting: &Setting::Auto,
                local: true,
            },
            &|_| true,
            &FakeRun::new(&[("runsc", Ok("4.19.0-gvisor"))]),
        );
        assert!(f.on.is_none() && f.held.unwrap().contains("did not say its own kernel"));
    }

    #[test]
    fn gvisor_first_then_kata_and_a_failure_is_said_beside_the_one_that_passed() {
        let mut l = vec![
            listed("kata", "", "io.containerd.kata.v2"),
            listed("runc", "runc", ""),
        ];
        l.extend(docker_with_runsc());
        let run = FakeRun::new(&[
            ("runsc", Err("exit status 128: cannot create sandbox")),
            ("kata", Ok("6.12.28")),
        ]);
        let f = find(&l, &Setting::Auto, &run);
        assert_eq!(run.asked(), ["runsc", "kata"]);
        assert_eq!(
            f.on,
            Some(Sandbox {
                runtime: "kata".into(),
                kind: Kind::Kata
            })
        );
        assert_eq!(
            f.held.unwrap(),
            "runsc: the smoke run failed: exit status 128: cannot create sandbox"
        );
        // Both failing: none, with both reasons.
        let run = FakeRun::new(&[("runsc", Err("no")), ("kata", Err("no /dev/kvm"))]);
        let f = find(&l, &Setting::Auto, &run);
        assert_eq!(f.on, None);
        assert_eq!(
            f.held.unwrap(),
            "runsc: the smoke run failed: no; kata: the smoke run failed: no /dev/kvm"
        );
    }

    #[test]
    fn what_podman_lists_but_this_machine_lacks_is_passed_over_and_said_nowhere() {
        let run = FakeRun::new(&[]);
        let absent = detect(
            &podman_lists(),
            HOST_KERNEL,
            Some(IMAGE),
            &Probe {
                setting: &Setting::Auto,
                local: true,
            },
            &|p| p == Path::new("/usr/bin/runc") || p == Path::new("/usr/bin/crun"),
            &run,
        );
        assert_eq!(absent, Found::default());
        assert!(run.asked().is_empty(), "nothing run for a runtime not here");
        // Installed: its smoke run decides.
        let run = FakeRun::new(&[("runsc", Ok("4.19.0-gvisor"))]);
        let f = detect(
            &podman_lists(),
            HOST_KERNEL,
            Some(IMAGE),
            &Probe {
                setting: &Setting::Auto,
                local: true,
            },
            &|p| p == Path::new("/usr/bin/runsc"),
            &run,
        );
        assert_eq!(f.on.unwrap().runtime, "runsc");
        assert_eq!(run.asked(), ["runsc"]);
        // On a Mac the engine's files are the VM's: nothing is passed over, the smoke run decides.
        let run = FakeRun::new(&[("runsc", Err("not found")), ("kata", Err("not found"))]);
        let f = detect(
            &podman_lists(),
            HOST_KERNEL,
            Some(IMAGE),
            &Probe {
                setting: &Setting::Auto,
                local: false,
            },
            &|_| false,
            &run,
        );
        assert_eq!(run.asked(), ["runsc", "kata"]);
        assert!(f.on.is_none());
    }

    #[test]
    fn the_envelope_turns_it_off_or_names_the_one() {
        // Off: nothing run, nothing said.
        let run = FakeRun::new(&[("runsc", Ok("4.19.0-gvisor"))]);
        assert_eq!(
            find(&docker_with_runsc(), &Setting::Off, &run),
            Found::default()
        );
        assert!(run.asked().is_empty());
        // Named: only that one, even where another would pass.
        let mut l = docker_with_runsc();
        l.push(listed("kata-qemu", "/opt/kata/bin/kata-runtime", ""));
        let run = FakeRun::new(&[("runsc", Ok("4.19.0-gvisor")), ("kata-qemu", Ok("6.1.0"))]);
        let f = find(&l, &Setting::Named("kata-qemu".into()), &run);
        assert_eq!(run.asked(), ["kata-qemu"]);
        assert_eq!(f.on.unwrap().kind, Kind::Kata);
        // Named but not listed, or listed but no sandbox: held, nothing run.
        let run = FakeRun::new(&[]);
        let f = find(&l, &Setting::Named("kata".into()), &run);
        assert_eq!(
            f.held.unwrap(),
            "the envelope names kata: the engine lists no such runtime"
        );
        let f = find(&l, &Setting::Named("runc".into()), &run);
        assert!(f.held.unwrap().contains("neither gVisor's runsc nor Kata"));
        assert!(run.asked().is_empty());
    }

    #[test]
    fn no_image_by_digest_checks_nothing_and_a_name_outside_the_grammar_is_never_run() {
        let run = FakeRun::new(&[("runsc", Ok("4.19.0-gvisor"))]);
        for image in [None, Some("docker.io/library/busybox:1.37")] {
            let f = detect(
                &docker_with_runsc(),
                HOST_KERNEL,
                image,
                &Probe {
                    setting: &Setting::Auto,
                    local: true,
                },
                &|_| true,
                &run,
            );
            assert_eq!(
                f.held.as_deref(),
                Some("runsc not checked: no build image by digest to run in it (a release names one)")
            );
        }
        let odd = vec![
            listed("--privileged", "/usr/local/bin/runsc", ""),
            listed("RunSC", "/usr/local/bin/runsc", ""),
        ];
        assert_eq!(find(&odd, &Setting::Auto, &run), Found::default());
        assert!(run.asked().is_empty());
    }

    #[test]
    fn the_settings_and_the_kinds_read() {
        assert_eq!(Setting::parse(None), Ok(Setting::Auto));
        assert_eq!(Setting::parse(Some("auto")), Ok(Setting::Auto));
        assert_eq!(Setting::parse(Some("off")), Ok(Setting::Off));
        assert_eq!(
            Setting::parse(Some("runsc")),
            Ok(Setting::Named("runsc".into()))
        );
        for bad in ["", "Runsc", "-x", "runsc --privileged", "a/b"] {
            assert!(Setting::parse(Some(bad)).is_err(), "{bad:?}");
        }
        assert_eq!(
            kind_of(&listed("io.containerd.runsc.v1", "", "")),
            Some(Kind::Gvisor)
        );
        assert_eq!(
            kind_of(&listed("secure", "", "io.containerd.kata-clh.v2")),
            Some(Kind::Kata)
        );
        assert_eq!(
            kind_of(&listed("sandbox", "/opt/gvisor/bin/runsc", "")),
            Some(Kind::Gvisor)
        );
        assert_eq!(kind_of(&listed("crun", "/usr/bin/crun", "")), None);
        assert_eq!(kind_of(&listed("runc", "runc", "")), None);
    }
}
