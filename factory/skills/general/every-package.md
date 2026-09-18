## Every package

What the pool checks on every package before it is evidence, and what a
recipe must do to pass. The gate (`vet_package`, in the build worker) runs
these checks deterministically, in this order, and writes `vet.json`; the
name in brackets is the check's name there. An agent drafting or auditing a
recipe follows the same list — it is the one list.

**Sources and checksums** [checksums]. Every download is the upstream
release — the project's own tag or release asset, never a fork, a mirror or
a paste — and every checksum is real. `SKIP` is allowed only for a VCS
source pinned to a commit or tag. A `-bin` package downloads the asset of
each architecture separately (`source_x86_64`, `source_aarch64`) with its
own checksum.

**The recipe reads cleanly** [shellcheck, namcap-pkgbuild]. shellcheck
finds no error in the PKGBUILD (the three codes makepkg makes false are
excluded: unused variables it consumes, `$pkgdir` it defines, `cd` under
`-e`). namcap finds no error in it: `url=`, `license=`, a `pkgdesc` that
does not repeat the name, `depends` that exist.

**The built package reads cleanly** [namcap-package]. namcap scans what was
built: every shared library an ELF file links is provided by `depends`
(glibc excepted: it cannot be uninstalled); no file is
world-writable or setuid unless the recipe says why; nothing from `$srcdir`
leaks into the package; ELF files live in `/usr` — or in `/opt`, which the
gate allows for a self-contained application (see *Desktop apps*).
Warnings are weighed, errors fail.

**Files where pacman expects them** [files]. Only `/usr`, `/etc` and
`/opt`; never `/usr/local`, `/bin`, `/lib`, `/home`, `/tmp` or a `tmp`
directory under `/opt/<name>`; no libtool `.la` archives; a package that
installs no file fails.

**Metadata that says what it is** [metadata]. `pkgdesc` and `license` are
set — the licence an SPDX identifier — and `url=` points at the project.
A licence Arch does not ship as a common one is installed under
`/usr/share/licenses/<pkgname>/`.

**Tests, or the reason there are none** [check]. `check()` runs the
upstream tests when they run offline and in reasonable time; otherwise the
recipe omits it with a one-line comment saying why (`# no check(): …`). A
missing `check()` with no reason is a warning the maintainer sees.

**It installs, and it starts** [smoke]. The gate installs the package with
a real pacman in the build container and starts every executable the
package puts in `/usr/bin` with `--version` (then `--help`). A binary that
cannot start — a shared library missing, a wrapper pointing at a path that
does not exist, exit 126 or 127 — fails. An application that needs a
display is checked differently: see *Desktop apps*.

**Dependencies** are Arch package names. `depends` is what the program
needs at run time (the libraries it links, the tools it calls);
`makedepends` the toolchain and headers; `optdepends` what unlocks a
feature, with a reason after the colon. Nothing base-devel provides is
listed. The runtime is named the way Arch names it since gcc-libs became
a meta-package (February 2026): `glibc` and `libgcc` for a binary that
links `libgcc_s` (a Rust binary does), `libstdc++` for C++, `libgomp`
for OpenMP — as Arch's own recipes do (ripgrep, fd, ninja). `gcc-libs`
in `depends` is namcap's `dependency-implicitly-satisfied`, a warning.
A dependency the build log mentions and the recipe omits is a finding.

**Provenance in the recipe.** The file begins with
`# Maintainer: omarchy-pool factory <https://github.com/firemanxbr/omarchy-pool>`
and `# Requested from: <project url>`; every non-obvious choice has a short
comment above it. No `sudo`, no network beyond `source=`, no prompts, no
`strip` by hand, `"$pkgdir"` and `"$srcdir"` always quoted.

**What an auditor writes.** Concrete findings only — the line, why it
matters, what to change — with the check's name when the gate has one, so
the maintainer sees the recipe and the evidence side by side. A sound
recipe gets a short *ok*, not invented problems.
