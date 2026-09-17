## Prebuilt binaries

Applies when the recipe repackages a release the project already built — a
tarball, an AppImage's contents, a `.deb`, a `.zip` — instead of building
from source. The package is named `<name>-bin` unless the project ships
only binaries.

**One asset per architecture.** `source_x86_64` and `source_aarch64`, each
the release asset for that architecture with its own checksum; a project
that ships one architecture gets `arch=('x86_64')` and nothing pretended.
Never `latest` in a URL — the tag, so the checksum can stay true.

**Unpack, do not rebuild.** `package()` extracts the asset into the
application directory (`bsdtar --no-same-owner -xf … -C "$pkgdir/opt/<name>"`
or `/usr/lib/<name>`), installs the launcher, the desktop entry, the icons
and the licence, and fixes what needs fixing: `chmod` the executables the
archive lost, `chrome-sandbox` to `4755`, `Exec=` in a bundled `.desktop`
rewritten to the wrapper. Nothing is compiled; `makedepends` is empty or
names only the tool that unpacks.

**Nothing to debug, nothing to strip.** Always `options=('!debug')`: the
recipe compiled nothing, so makepkg's default `debug` option would only
make a `-debug` split of dangling build-id symlinks, which the gate fails
[prebuilt-debug]. Add `!strip` when the vendor's binaries carry their own
symbols or signatures, and say why. An unstripped ELF is a namcap warning,
not an error.

**Libraries.** The gate runs `ldd` on the real executable: every shared
library resolves, or the package fails. What resolves through the system
goes in `depends`; what the archive bundles (its own `lib/` directory) is
found through the application's own rpath or `LD_LIBRARY_PATH` set by the
wrapper — never by copying files into `/usr/lib`.

**What an auditor looks for.** A `.deb` unpacked with its `/usr/local`,
`/etc/init.d` or `postinst` scripts; a checksum that is `SKIP` on a
downloaded binary; an asset from a fork or a CDN the project does not name;
a version in the URL that does not match `pkgver`; files the archive
scattered outside the application directory.
