## Desktop apps

Applies when the package ships a graphical application: it installs a
`.desktop` file under `/usr/share/applications`, or its main executable
links a toolkit (GTK, Qt, Electron/Chromium — `libX11`, `libwayland-client`,
`libgtk-3`, `libgtk-4`, `libQt5Gui`, `libQt6Gui`). Most of these are
repackaged releases — Electron apps above all — so read *Prebuilt binaries*
too.

**Where it lives.** A self-contained application (Electron, a JetBrains
IDE, anything shipping its own runtime) goes whole into `/opt/<name>/` or
`/usr/lib/<name>/` — one directory, nothing scattered. The gate allows ELF
files under `/opt` for this reason and nowhere else. An application that
follows the FHS on its own (a GTK or Qt program built from source with
`--prefix=/usr`) installs normally under `/usr`.

**The launcher in `/usr/bin`.** A small shell wrapper, never a symlink to
the real binary:

```sh
#!/bin/sh
exec /opt/<name>/<binary> --ozone-platform-hint=auto "$@"
```

The wrapper passes `"$@"` through, adds nothing a user would not want, and
never `--no-sandbox`: an Electron app that needs it is packaged wrong, not
worked around. (`--ozone-platform-hint=auto` lets Chromium pick Wayland or
X11 at run time; it is harmless on either.)

**The desktop entry and the icons.** `/usr/share/applications/<name>.desktop`
with `Exec=<name> %U` (the wrapper, by name, not an absolute path into
`/opt`), `Icon=<name>`, a `Categories=` line; the icons under
`/usr/share/icons/hicolor/<size>x<size>/apps/<name>.png` (or `scalable/apps/<name>.svg`),
as symlinks into the application's own directory when it ships them. The
gate validates the entry with `desktop-file-validate`.

**Electron and Chromium.** `chrome-sandbox` inside the application
directory is `4755` (root-owned setuid) — that is the one setuid file the
gate accepts, and the recipe says so in a comment. `depends` lists what the
bundled Chromium needs at run time on Arch: `gtk3`, `nss`, `alsa-lib`,
`libxss`, `libnotify`, `libxtst`, `xdg-utils`, `at-spi2-core`, `libcups`
(namcap reports what the ELF scan finds; the log of a failed start says the
rest). The licence file the app ships is installed under
`/usr/share/licenses/<pkgname>/`.

**What the gate does instead of starting it.** A graphical application
cannot start in the build container — no display, no D-Bus — so the gate
does not count its exit code. It checks what a start would have proved: the
real executable behind the wrapper exists and is executable; `ldd` on it
resolves every shared library (a *not found* fails); the `.desktop` entry is
valid and its `Exec=` names something on the path. `--version` is still
tried, and a version printed is noted; a crash for want of a display is
not a failure.

**What an auditor looks for.** A symlink where the wrapper should be; a
`--no-sandbox`; an `Exec=` with an absolute path into `/opt`; icons missing
so the entry shows a blank; `chrome-sandbox` without setuid (the app will
refuse to start) or setuid on anything else; libraries the ELF scan needs
that `depends` does not name; a `.desktop` the upstream ships that the
recipe forgot to install.
