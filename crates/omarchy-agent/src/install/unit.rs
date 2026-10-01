//! The systemd --user unit and linger (#317, design v2 §13.2 step 9, §19.1): the unit in
//! `run/omarchy-agent.service` (`Type=notify`, `Restart=always`, `TimeoutStartSec=120`,
//! `WatchdogSec=300`, `RestartPreventExitStatus=78`, `UMask=0077`, `NoNewPrivileges=yes`,
//! wanted by `default.target`), its `ExecStart` pointed at this data directory; linger so
//! the user manager — and the agent with it — starts at boot without a login.

use std::fmt::Write as _;
use std::path::Path;

use super::Sys;

pub(crate) const NAME: &str = "omarchy-agent.service";
const TEMPLATE: &str = include_str!("../run/omarchy-agent.service");

/// The unit for an agent whose data directory is `data`. A path systemd would read
/// differently (whitespace, quotes, `%`, a backslash) is refused.
pub(crate) fn render(data: &Path) -> Result<String, String> {
    let d = data.display().to_string();
    if d.chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '%' | '\\'))
    {
        return Err(format!(
            "{d}: the data directory goes into the unit's ExecStart, so it may hold no whitespace, quote, % or backslash"
        ));
    }
    let mut out = String::new();
    for line in TEMPLATE.lines() {
        if line.starts_with("ExecStart=") {
            let _ = write!(
                out,
                "ExecStart={d}/current/omarchy-agent run --data-dir {d}"
            );
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    Ok(out)
}

/// Linger on: already, through `loginctl enable-linger` where polkit lets this user, or a
/// person's line to run.
pub(crate) fn linger(sys: &mut dyn Sys, user: &str) -> Result<(), String> {
    if sys
        .run(
            "loginctl",
            &["show-user", user, "--property=Linger", "--value"],
        )
        .is_ok_and(|v| v.trim() == "yes")
    {
        return Ok(());
    }
    match sys.run("loginctl", &["enable-linger", user]) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!(
            "needs a person: linger could not be enabled without sudo ({e}); run `sudo loginctl enable-linger {user}` so the agent starts at boot"
        )),
    }
}

/// The unit loaded, enabled and (re)started.
pub(crate) fn start(sys: &mut dyn Sys) -> Result<(), String> {
    for args in [
        &["--user", "daemon-reload"][..],
        &["--user", "enable", NAME],
        &["--user", "restart", NAME],
    ] {
        sys.run("systemctl", args).map_err(|e| {
            format!(
                "needs a person: systemctl {} failed ({e}); run `systemctl --user daemon-reload && systemctl --user enable --now {NAME}` in a login session",
                args.join(" ")
            )
        })?;
    }
    Ok(())
}

/// The unit stopped and disabled (uninstall); a unit that is not there is no error.
pub(crate) fn stop(sys: &mut dyn Sys) {
    let _ = sys.run("systemctl", &["--user", "disable", "--now", NAME]);
}

pub(crate) fn reload(sys: &mut dyn Sys) {
    let _ = sys.run("systemctl", &["--user", "daemon-reload"]);
}
