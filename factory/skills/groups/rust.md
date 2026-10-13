## Rust

Applies when the project builds with Cargo: a `Cargo.toml` at the top of
its tree, a single crate or a workspace of several.

**The package's crate, not the workspace.** When the top `Cargo.toml` is a
`[workspace]` and the package is one of its members — a client beside a
server, an agent, benchmarks — build and test that member alone:
`cargo build --frozen --release -p <crate>` and
`cargo test --frozen --release -p <crate>`. `-p` builds the crate's own
path dependencies in the workspace; `--workspace` builds every member and
runs every member's tests, which may need a host, a network or a service
the build container does not have, and links dependencies the package
never ships. `install` only that crate's binaries from `target/release/`,
by name — never every executable the directory holds.

**The lock as committed.** `cargo fetch --locked --target "$(rustc -vV |
sed -n 's/host: //p')"` in `prepare()`, then `--frozen` in `build()` and
`check()`: the upstream's `Cargo.lock` and no network. Never `cargo
update`, never a lock of the recipe's own; a lock that does not match the
manifest is upstream's to fix, and the build says so.

**No makepkg LTO** [lto]. Always `options=('!lto')`, with a comment saying
why. makepkg's `lto` option adds `-flto=auto` to `CFLAGS`, and the `cc`
crate compiles a crate's C and assembly — `ring`, `aws-lc-sys`, `zstd-sys`,
`libgit2-sys` — with it, so GCC writes objects that hold only its LTO
bytecode. Arch's `rust` links through `gcc -fuse-ld=lld` (its targets'
linker flavour is `gnu-lld-cc`), and ld.lld cannot read GCC's bytecode:
the link fails with every symbol of those crates undefined
(`ring_core_0_17_14__…`). Arch Linux ARM's `makepkg.conf` has `!lto`, so
the same recipe links on aarch64 and fails on x86_64 only. Cargo's own
`[profile.release] lto` is the upstream's and is not touched by the
option.

**Dependencies.** `makedepends=('cargo')` (Arch's `rust` provides it); a C
toolchain is base-devel's. `depends` as *Every package* says: `glibc`
and `libgcc`, and the Arch package of each `-sys` crate that links a
system library — not of one that builds and links its own vendored copy.

**What an auditor looks for.** `--workspace`, or no `-p`, in a workspace
whose members are not all the package; a `check()` that runs tests of
crates the package does not ship; `lto` left on; `cargo update` or a
build without `--locked`/`--frozen`; a `package()` that installs every
file of `target/release/`.
