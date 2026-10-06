//! The `LaunchAgent` on macOS (#320; design v2 §19.2, v1 §14.2):
//! `~/Library/LaunchAgents/org.omarchy-pool.agent.plist` with `RunAtLoad`, `KeepAlive`,
//! `ThrottleInterval` 10, `ProcessType` Background, `Umask` 63 (0077), an explicit `PATH`
//! (launchd's lacks `/opt/homebrew/bin`, where Colima and Lima are) and `HOME`, and logs in
//! `~/Library/Logs/omarchy-agent/`; loaded with `launchctl bootstrap gui/<uid>`.
//!
//! A `LaunchAgent` is login-scoped: it starts at the person's login, and a Mac sitting at
//! the login window after a boot runs no agent (a headless Mac at boot is unsupported).
//! launchd restarts the agent only when it exits, so a hang is the agent's own progress
//! watchdog's to end (`run::cli`), which makes it a counted start of a self-update.
//! `launchctl bootstrap gui/<uid>` needs the person's GUI login: from an SSH session
//! without one it fails, so [`gui`] asks first and says to run the installer from
//! Terminal instead of failing obscurely.

use std::fmt::Write as _;
use std::path::Path;

use super::Sys;

pub(crate) const LABEL: &str = "org.omarchy-pool.agent";
pub(crate) const PLIST: &str = "org.omarchy-pool.agent.plist";
/// The log file under `~/Library/Logs/omarchy-agent/`.
pub(crate) const LOG: &str = "agent.log";

fn xml(s: &str) -> Result<String, String> {
    if s.chars().any(char::is_control) {
        return Err(format!(
            "{s:?}: a control character cannot go into the LaunchAgent's plist"
        ));
    }
    Ok(s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;"))
}

/// The plist for an agent whose data directory is `data`: `ProgramArguments` start
/// `<data>/current/omarchy-agent run --data-dir <data>`, as install.sh put it there.
/// `env` adds to `PATH` and `HOME` (`COLIMA_HOME` when the person set one at install).
pub(crate) fn render(
    data: &Path,
    home: &Path,
    logs: &Path,
    env: &[(&str, String)],
) -> Result<String, String> {
    let d = xml(&data.display().to_string())?;
    let mut vars = vec![
        ("PATH", crate::vm::PATH.to_owned()),
        ("HOME", home.display().to_string()),
    ];
    vars.extend(env.iter().map(|(k, v)| (*k, v.clone())));
    let mut env_xml = String::new();
    for (k, v) in &vars {
        let _ = write!(
            env_xml,
            "\n    <key>{}</key>\n    <string>{}</string>",
            xml(k)?,
            xml(v)?
        );
    }
    let log = xml(&logs.join(LOG).display().to_string())?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- The omarchy-pool host agent (omarchy-agent install, #320; design v2 §19.2). A
     LaunchAgent is login-scoped: it starts at your login, not at boot. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{d}/current/omarchy-agent</string>
    <string>run</string>
    <string>--data-dir</string>
    <string>{d}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>{env_xml}
  </dict>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#
    ))
}

/// What to run, in Terminal at the Mac, when the agent could not be loaded from here.
pub(crate) fn by_hand(uid: u32, plist: &Path) -> String {
    format!("launchctl bootstrap gui/{uid} {}", plist.display())
}

/// Whether this user has a GUI login, which `launchctl bootstrap gui/<uid>` needs: its
/// `gui/<uid>` domain answers `launchctl print`. Without one (an SSH session, nobody
/// logged in at the Mac) the installer says to run it from Terminal.
pub(crate) fn gui(sys: &mut dyn Sys, uid: u32, ssh: bool) -> Result<(), String> {
    match sys.run("launchctl", &["print", &format!("gui/{uid}")]) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!(
            "no GUI login: launchctl has no gui/{uid} domain for this user{} ({e}); a LaunchAgent is login-scoped, so log in at the Mac and run the installer from Terminal there",
            if ssh { ", and this is an SSH session" } else { "" }
        )),
    }
}

/// Whether the agent is loaded in `gui/<uid>`.
fn loaded(sys: &mut dyn Sys, uid: u32) -> bool {
    sys.run("launchctl", &["print", &format!("gui/{uid}/{LABEL}")])
        .is_ok()
}

/// The agent (re)loaded: the one already loaded booted out first, so a changed plist is
/// read again, then `launchctl bootstrap gui/<uid> <plist>` (`RunAtLoad` starts it).
pub(crate) fn start(sys: &mut dyn Sys, uid: u32, plist: &Path, ssh: bool) -> Result<(), String> {
    gui(sys, uid, ssh).map_err(|e| {
        format!(
            "needs a person: {e}; or, in Terminal at the Mac: {}",
            by_hand(uid, plist)
        )
    })?;
    if loaded(sys, uid) {
        let _ = sys.run("launchctl", &["bootout", &format!("gui/{uid}/{LABEL}")]);
    }
    let path = plist.display().to_string();
    sys.run("launchctl", &["bootstrap", &format!("gui/{uid}"), &path])
        .map(drop)
        .map_err(|e| {
            format!(
                "needs a person: launchctl bootstrap failed ({e}); run, in Terminal at the Mac: {}",
                by_hand(uid, plist)
            )
        })
}

/// The agent unloaded (uninstall). One that is not loaded is no error; a session that
/// cannot reach `gui/<uid>` stops uninstall before anything is removed, since the agent
/// would go on running and roll the bundle out again.
pub(crate) fn stop(sys: &mut dyn Sys, uid: u32, ssh: bool) -> Result<(), String> {
    if !loaded(sys, uid) {
        // Not loaded here, or no GUI domain to look in: the latter is the person's.
        return gui(sys, uid, ssh).map_err(|e| {
            format!("needs a person: {e} (run uninstall from Terminal there); nothing was removed")
        });
    }
    sys.run("launchctl", &["bootout", &format!("gui/{uid}/{LABEL}")])
        .map(drop)
        .map_err(|e| {
            format!(
                "needs a person: launchctl bootout gui/{uid}/{LABEL} failed ({e}); run uninstall from Terminal at the Mac; nothing was removed"
            )
        })
}
