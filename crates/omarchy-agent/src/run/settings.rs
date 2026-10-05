//! The host's settings (#325, design v2 §12, §17.1): its units and its emulated lanes,
//! which the pool may only narrow, inside the envelope the owner wrote at the host.
//!
//! The pool gives them as host orders, `set-units <n>` and `set-emulate <archs>`; the agent
//! keeps what it took in `state.json` and applies it to `run/capacity.json`, the file the
//! dispatcher reads before every claim and sends with it: the units there become
//! `min(detected, the envelope's max_units, the setting)`, and an emulated lane stays only
//! when both the envelope's `emulate` and the setting name its architecture. The detected
//! values ride the file under `detected`, so a later setting — wider again, up to the
//! envelope — starts from them, never from a narrowing. The pool computes its own units
//! from the reported totals and takes the smaller of the two, so a narrowed host is handed
//! no more at its next claim; a dispatcher holding more than the new count claims nothing
//! until its leases fit, and never kills a running task for it (design v2 §7.6). The lanes
//! left in the file ride every claim too, and the pool's selection (#337) hands an emulated
//! build only to a lane the claim names, so a lane turned off takes no new emulated build
//! from the next claim. Running emulated builds on the host — detection per foreign
//! architecture, `needs_native` per lane — is #338's: its dispatcher must claim only the
//! emulated lanes this file lists.
//!
//! Anything above the envelope is refused here, whatever the pool asks: units above the
//! detected count or `max_units`, a lane the envelope's `emulate` excludes. When the owner
//! lowers the envelope below a setting taken earlier, the envelope wins and the report says
//! which part of the setting it leaves out (`above`).

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::config::{Policy, ARCHES};

/// What the pool narrowed, as the agent took it; `None` is the envelope's own.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// `set-units`: at most this many units.
    pub units: Option<u32>,
    /// `set-emulate`: the emulated lanes that may run (`[]`: none).
    pub emulate: Option<Vec<String>>,
}

impl Settings {
    pub fn is_empty(&self) -> bool {
        self.units.is_none() && self.emulate.is_none()
    }
}

/// `run/capacity.json` as detection wrote it, read through a narrowing the agent applied:
/// the detected units and lanes, and the file's other fields.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Base {
    file: Map<String, Value>,
}

const DETECTED: &str = "detected";
const SETTINGS: &str = "settings";

impl Base {
    /// Reads the file in the set directory; `Ok(None)` when there is none. A `run/` or a
    /// `capacity.json` that is a link is refused, never followed.
    pub fn read(set_dir: &Path) -> Result<Option<Self>, String> {
        let path = file(set_dir);
        for p in [set_dir.join("run"), path.clone()] {
            if fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(format!("{} is a symbolic link; not followed", p.display()));
            }
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        Self::parse(&bytes)
            .map(Some)
            .map_err(|e| format!("{}: {e}", path.display()))
    }

    /// The file's bytes, read through a narrowing (the fuzz target's too).
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let Ok(Value::Object(mut file)) = serde_json::from_slice::<Value>(bytes) else {
            return Err("not a JSON object".into());
        };
        if let Some(Value::Object(d)) = file.remove(DETECTED) {
            file.extend(d);
        }
        file.remove(SETTINGS);
        Ok(Base { file })
    }

    /// The detected units, when the file says them.
    pub fn units(&self) -> Option<u32> {
        self.file
            .get("units")
            .and_then(Value::as_u64)
            .and_then(|u| u32::try_from(u).ok())
    }

    fn lanes(&self) -> Vec<Value> {
        self.file
            .get("lanes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    /// The native lane's architecture: the file's, else this machine's.
    pub fn native(&self) -> String {
        self.lanes()
            .iter()
            .find(|l| l["mode"] == "native")
            .and_then(|l| l["arch"].as_str())
            .unwrap_or(std::env::consts::ARCH)
            .to_owned()
    }

    /// The architectures of the emulated lanes detection found.
    pub fn emulated(&self) -> Vec<String> {
        self.lanes()
            .iter()
            .filter(|l| l["mode"] == "emulated")
            .filter_map(|l| l["arch"].as_str().map(str::to_owned))
            .collect()
    }

    /// The most units the envelope lets the host give: the detected count, and the
    /// envelope's `max_units` when it is lower.
    pub fn ceiling(&self, p: &Policy) -> Option<u32> {
        let u = self.units()?;
        Some(p.max_units.map_or(u, |m| u.min(m)))
    }

    /// The file with `s` and the envelope applied (the [`Effect`] says what it gives).
    pub fn narrowed(&self, s: &Settings, p: &Policy) -> (Map<String, Value>, Effect) {
        let mut out = self.file.clone();
        let ceiling = self.ceiling(p);
        let units = match (ceiling, s.units) {
            (Some(c), Some(u)) => Some(c.min(u)),
            (c, _) => c,
        };
        let lanes: Vec<Value> = self
            .lanes()
            .into_iter()
            .filter(|l| {
                l["mode"] != "emulated"
                    || l["arch"].as_str().is_some_and(|a| {
                        p.allows_lane(a)
                            && s.emulate.as_ref().is_none_or(|e| e.iter().any(|x| x == a))
                    })
            })
            .collect();
        let emulated: Vec<String> = lanes
            .iter()
            .filter(|l| l["mode"] == "emulated")
            .filter_map(|l| l["arch"].as_str().map(str::to_owned))
            .collect();
        if let Some(u) = units {
            out.insert("units".into(), u.into());
            if let Some(j) = self.file.get("job_reserved").and_then(Value::as_u64) {
                out.insert("job_reserved".into(), j.min(u64::from(u)).into());
            }
        }
        if self.file.contains_key("lanes") {
            out.insert("lanes".into(), Value::Array(lanes));
        }
        if out != self.file {
            let mut d = Map::new();
            for k in ["units", "job_reserved", "lanes"] {
                if let Some(v) = self.file.get(k) {
                    d.insert(k.into(), v.clone());
                }
            }
            out.insert(DETECTED.into(), Value::Object(d));
            out.insert(
                SETTINGS.into(),
                serde_json::to_value(s).unwrap_or(Value::Null),
            );
        }
        let mut above = Vec::new();
        if let (Some(c), Some(u)) = (ceiling, s.units) {
            if u > c {
                above.push(format!(
                    "units {u} is above the envelope's {c}: {c} applies"
                ));
            }
        }
        for a in s.emulate.iter().flatten() {
            if !p.allows_lane(a) {
                above.push(format!(
                    "{a}'s emulated lane is one the envelope excludes: it stays off"
                ));
            }
        }
        let effect = Effect {
            detected: self.units(),
            ceiling,
            units,
            emulated,
            above,
        };
        (out, effect)
    }
}

/// What the settings give now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Effect {
    pub detected: Option<u32>,
    pub ceiling: Option<u32>,
    pub units: Option<u32>,
    pub emulated: Vec<String>,
    pub above: Vec<String>,
}

fn file(set_dir: &Path) -> std::path::PathBuf {
    set_dir.join("run").join("capacity.json")
}

/// Writes the narrowed file when it differs from what is there; `Ok(true)` when it was
/// rewritten (a round then recreates the dispatcher with it: its bind mount holds the
/// file it was created with). `Ok(None)`-like: no file, nothing to narrow.
pub(crate) fn apply(
    set_dir: &Path,
    s: &Settings,
    p: &Policy,
) -> Result<Option<(bool, Effect)>, String> {
    let Some(base) = Base::read(set_dir)? else {
        return Ok(None);
    };
    let (narrowed, effect) = base.narrowed(s, p);
    let path = file(set_dir);
    let now: Option<Value> = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let narrowed = Value::Object(narrowed);
    if now.as_ref() == Some(&narrowed) {
        return Ok(Some((false, effect)));
    }
    let mut bytes = serde_json::to_vec(&narrowed).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    super::state::write_atomic(&path, &bytes)?;
    Ok(Some((true, effect)))
}

/// Checks a `set-units` against the envelope: `Err` with why it is refused.
pub(crate) fn check_units(n: Option<u32>, base: Option<&Base>, p: &Policy) -> Result<(), String> {
    let Some(n) = n else { return Ok(()) };
    let Some(ceiling) = base.and_then(|b| b.ceiling(p)) else {
        return Err(
            "run/capacity.json is missing or names no units (capacity detection, #333): there is nothing to narrow"
                .into(),
        );
    };
    if n == 0 {
        return Err("units: at least 1 — a host that should take nothing is drained (Drain on its registration's page), not narrowed".into());
    }
    if n > ceiling {
        let why = match (p.max_units, base.and_then(Base::units)) {
            (Some(m), Some(d)) if m < d => {
                format!("its envelope's max_units is {m} (detected {d})")
            }
            _ => format!("it detected {ceiling}"),
        };
        return Err(format!(
            "{n} units is above this host's envelope: {why}, and only its owner widens that, at the host"
        ));
    }
    Ok(())
}

/// Checks a `set-emulate` against the envelope: the architectures it names, sorted and
/// once each, or why it is refused.
pub(crate) fn check_emulate(
    archs: Option<&[String]>,
    native: &str,
    p: &Policy,
) -> Result<Option<Vec<String>>, String> {
    let Some(archs) = archs else { return Ok(None) };
    let mut out: Vec<String> = Vec::new();
    for a in archs {
        if !ARCHES.contains(&a.as_str()) {
            return Err(format!("{a:?} is not an architecture (x86_64 or aarch64)"));
        }
        if a == native {
            return Err(format!(
                "{a} is this host's native lane, not an emulated one: it is never turned off this way"
            ));
        }
        if !p.allows_lane(a) {
            return Err(format!(
                "{a}'s emulated lane is one the envelope excludes (emulate = {:?} in agent.toml): only its owner widens that, at the host",
                p.emulate.clone().unwrap_or_default()
            ));
        }
        if !out.contains(a) {
            out.push(a.clone());
        }
    }
    out.sort();
    Ok(Some(out))
}

/// The settings as the report says them (design v2 §17.2's `settings`, #325): what the pool
/// narrowed, the envelope it narrows inside, and what applies.
pub(crate) fn view(s: Option<&Settings>, set_dir: &Path, p: &Policy) -> Value {
    let base = Base::read(set_dir).ok().flatten();
    let effect = base
        .as_ref()
        .map(|b| b.narrowed(s.unwrap_or(&Settings::default()), p).1);
    serde_json::json!({
        "units": s.and_then(|s| s.units),
        "emulate": s.and_then(|s| s.emulate.clone()),
        "envelope": {
            "max_units": effect.as_ref().and_then(|e| e.ceiling),
            "detected_units": effect.as_ref().and_then(|e| e.detected),
            "emulate": p.emulate,
            "detected_lanes": base.as_ref().map(Base::emulated),
            "diagnostics": p.diagnostics,
        },
        "effective": {
            "units": effect.as_ref().and_then(|e| e.units),
            "emulated": effect.as_ref().map(|e| e.emulated.clone()),
        },
        "above": effect.map(|e| e.above).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::state::tempdir;

    /// The Studio's file: 11 units, the native `aarch64` lane and an emulated `x86_64` one.
    const STUDIO: &str = r#"{"schema":2,"at":"2027-01-15T08:00:00Z","cpus":12,"mem_gb":32,"page_kb":16,
        "disk_free_gb":{"work":410,"engine":220},"units":11,"job_reserved":1,"agent_slots":2,
        "lanes":[{"arch":"aarch64","mode":"native"},{"arch":"x86_64","mode":"emulated","via":"qemu","page16k":true}],
        "isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}"#;

    fn studio() -> std::path::PathBuf {
        let d = tempdir();
        fs::create_dir_all(d.join("run")).unwrap();
        fs::write(d.join("run/capacity.json"), STUDIO).unwrap();
        d
    }

    fn read(d: &Path) -> Value {
        serde_json::from_slice(&fs::read(d.join("run/capacity.json")).unwrap()).unwrap()
    }

    fn policy(max_units: Option<u32>, emulate: Option<&[&str]>) -> Policy {
        Policy {
            max_units,
            emulate: emulate.map(|e| e.iter().map(|a| (*a).to_owned()).collect()),
            diagnostics: false,
            drivers: vec!["compose".into()],
        }
    }

    #[test]
    fn the_units_are_the_smallest_of_detection_the_envelope_and_the_setting() {
        let d = studio();
        let p = policy(None, None);
        // No setting: the file stays as detection wrote it.
        let (changed, e) = apply(&d, &Settings::default(), &p).unwrap().unwrap();
        assert!(!changed);
        assert_eq!((e.ceiling, e.units), (Some(11), Some(11)));
        assert_eq!(read(&d), serde_json::from_str::<Value>(STUDIO).unwrap());

        let four = Settings {
            units: Some(4),
            emulate: None,
        };
        let (changed, e) = apply(&d, &four, &p).unwrap().unwrap();
        assert!(changed);
        assert_eq!(e.units, Some(4));
        let f = read(&d);
        assert_eq!(
            (f["units"].as_u64(), f["job_reserved"].as_u64()),
            (Some(4), Some(1))
        );
        assert_eq!(f["detected"]["units"], 11);
        assert_eq!(f["settings"]["units"], 4);
        // Every other field as detection wrote it, `at` too.
        assert_eq!(f["at"], "2027-01-15T08:00:00Z");
        assert_eq!(f["lanes"].as_array().unwrap().len(), 2);
        // Applied again: nothing to write.
        assert!(!apply(&d, &four, &p).unwrap().unwrap().0);

        // Wider again, up to the envelope: from the detected count, never the narrowing.
        let (_, e) = apply(
            &d,
            &Settings {
                units: Some(9),
                emulate: None,
            },
            &p,
        )
        .unwrap()
        .unwrap();
        assert_eq!(e.units, Some(9));
        // The envelope's max_units lowered by the owner below the setting: the envelope wins.
        let (_, e) = apply(
            &d,
            &Settings {
                units: Some(9),
                emulate: None,
            },
            &policy(Some(6), None),
        )
        .unwrap()
        .unwrap();
        assert_eq!((e.ceiling, e.units), (Some(6), Some(6)));
        assert_eq!(e.above, ["units 9 is above the envelope's 6: 6 applies"]);
        assert_eq!(read(&d)["units"], 6);
        // Back to the envelope's: detection's file again, with nothing of the narrowing.
        apply(&d, &Settings::default(), &p).unwrap();
        assert_eq!(read(&d), serde_json::from_str::<Value>(STUDIO).unwrap());
    }

    #[test]
    fn an_emulated_lane_runs_only_while_the_envelope_and_the_setting_both_name_it() {
        let d = studio();
        let off = Settings {
            units: None,
            emulate: Some(Vec::new()),
        };
        let (changed, e) = apply(&d, &off, &policy(None, Some(&["x86_64"])))
            .unwrap()
            .unwrap();
        assert!(changed);
        assert!(e.emulated.is_empty());
        let f = read(&d);
        assert_eq!(
            f["lanes"],
            serde_json::json!([{"arch":"aarch64","mode":"native"}])
        );
        assert_eq!(f["units"], 11);
        assert_eq!(f["detected"]["lanes"].as_array().unwrap().len(), 2);
        // On again.
        let on = Settings {
            units: None,
            emulate: Some(vec!["x86_64".into()]),
        };
        let (_, e) = apply(&d, &on, &policy(None, Some(&["x86_64"])))
            .unwrap()
            .unwrap();
        assert_eq!(e.emulated, ["x86_64"]);
        assert_eq!(read(&d), serde_json::from_str::<Value>(STUDIO).unwrap());
        // The envelope turned emulation off at the host: the setting cannot turn it on.
        let (_, e) = apply(&d, &on, &policy(None, Some(&[]))).unwrap().unwrap();
        assert!(e.emulated.is_empty());
        assert_eq!(
            e.above,
            ["x86_64's emulated lane is one the envelope excludes: it stays off"]
        );
    }

    #[test]
    fn an_order_above_the_envelope_is_refused_with_why() {
        let d = studio();
        let base = Base::read(&d).unwrap().unwrap();
        let p = policy(Some(8), Some(&[]));
        assert!(check_units(Some(8), Some(&base), &p).is_ok());
        assert!(check_units(None, Some(&base), &p).is_ok());
        assert_eq!(
            check_units(Some(9), Some(&base), &p).unwrap_err(),
            "9 units is above this host's envelope: its envelope's max_units is 8 (detected 11), and only its owner widens that, at the host"
        );
        assert_eq!(
            check_units(Some(12), Some(&base), &policy(None, None)).unwrap_err(),
            "12 units is above this host's envelope: it detected 11, and only its owner widens that, at the host"
        );
        assert!(check_units(Some(0), Some(&base), &p)
            .unwrap_err()
            .starts_with("units: at least 1"));
        assert!(check_units(Some(2), None, &p)
            .unwrap_err()
            .contains("nothing to narrow"));

        let x = vec!["x86_64".to_owned()];
        assert_eq!(
            check_emulate(Some(&x), "aarch64", &p).unwrap_err(),
            "x86_64's emulated lane is one the envelope excludes (emulate = [] in agent.toml): only its owner widens that, at the host"
        );
        assert_eq!(
            check_emulate(Some(&x), "aarch64", &policy(None, Some(&["x86_64"]))).unwrap(),
            Some(x.clone())
        );
        assert_eq!(
            check_emulate(Some(&[]), "aarch64", &p).unwrap(),
            Some(Vec::new())
        );
        assert!(check_emulate(
            Some(&["aarch64".to_owned()]),
            "aarch64",
            &policy(None, None)
        )
        .unwrap_err()
        .contains("native lane"));
        assert!(check_emulate(
            Some(&["riscv64".to_owned()]),
            "aarch64",
            &policy(None, None)
        )
        .unwrap_err()
        .contains("not an architecture"));
    }

    #[test]
    fn a_linked_file_is_refused_and_a_missing_one_is_nothing_to_narrow() {
        let d = tempdir();
        assert_eq!(
            apply(&d, &Settings::default(), &policy(None, None)).unwrap(),
            None
        );
        fs::create_dir_all(d.join("run")).unwrap();
        let outside = d.join("outside.json");
        fs::write(&outside, STUDIO).unwrap();
        std::os::unix::fs::symlink(&outside, d.join("run/capacity.json")).unwrap();
        assert!(apply(
            &d,
            &Settings {
                units: Some(2),
                emulate: None
            },
            &policy(None, None)
        )
        .unwrap_err()
        .contains("symbolic link"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), STUDIO);
    }
}
