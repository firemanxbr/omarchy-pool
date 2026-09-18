# Open work

Open work, roughly in order of value for effort. The POC questions are answered
(see [poc/RESULTS.md](poc/RESULTS.md)) and the staging environment runs
the whole pipeline on every upstream repository; everything here is what would
turn it into something the migration can rely on. Pick an item, open a pull
request (see [CONTRIBUTING.md](CONTRIBUTING.md)), and keep
[docs/TESTING.md](docs/TESTING.md) in step with what you add.

## Quick wins (an hour or so each)


## Medium (half a day)



## Larger (needs a design conversation first)

- [ ] **Audit the rebuild too.** The second agent reads the staged
      evidence; a second pass on the project's own rebuild (its log and
      `.PKGINFO` against the staged ones) would catch a recipe that builds
      differently on the trusted worker.

- [ ] **Production keys and hosting.** The staging database key is throwaway and
      the pool lives on a personal account; moving to omarchy.org means a key in
      the team's custody (one Worker secret, `SIGNING_KEY`, RUNBOOK *Rotate the
      signing key*), the Cloudflare resources in the team's account, and
      the OAuth App and the two hosted-worker tokens registered under it.
- [ ] **Native install engine.** `poc/crates/pkg-store` (redb state + journaled,
      crash-safe transactions) is implemented and tested but not wired into the
      client. Wiring it means also writing pacman's local database
      (`/var/lib/pacman/local/<pkg>/{desc,files,mtree}`) and running `.hook` /
      `.INSTALL` scriptlets, or pacman and yay stop seeing what it installs.
      Decision (2026-09-13): not now — the thin client covers status, the ABI
      check, the hook preview, security and the MCP surface, and pacman does
      the installing; the parked crate stays compiled and tested for the day
      that changes.
- [ ] **Multi-repo per ring.** `release_artifacts` is keyed by `(repo, arch)` already;
      a second repository from the same upstream (an `omarchy-t2`, say) is a new
      source — the recipe is in the RUNBOOK (*Adding a repository*), two lines
      and a keyring. Nothing upstream publishes one yet (checked 2026-09-13:
      `pkgs.omarchy.org` serves `omarchy.db` only), so nothing to wire until
      it does.

## Upstream findings worth reporting

Written up, with the suggested text for each, in
[docs/upstream/README.md](docs/upstream/README.md): Arch Linux ARM's x86_64
binaries in aarch64 packages, the OPR's `opencode` signed outside the
published keyring, the OPR's per-channel rebuilds of the same version. Filing
them is a maintainer's act; the health-summary parse is verified fixed.

## Housekeeping

- [ ] Rotate the staging key (`docs/omarchy-staging.pub.asc`, expires 2027-09-12)
      before it expires; it is the Worker secret `SIGNING_KEY` (RUNBOOK).
- [x] ~~The `events` table grows by ~1.5k rows a month from the metrics snapshots~~ — the snapshot prunes the ones older than 90 days.

## Done (kept for the record)

Pool retention with grace period · signature verification on import against the
upstream keyrings · resilient publishing (retries, parallel imports, per-source
reports) · every Arch, Arch Linux ARM and OPR repository mirrored on both
architectures · paged release view · evidence-driven promotion with ABI check and
automatic rollback · releases of the pool itself by dispatch · dashboard with
coverage, charts and pipeline metrics · user-facing dashboard (rings guidance, Get
started, How it works, Status, API docs, mobile) · package search and package page
with dependency graph · OPR channels per ring, chaotic-aur as optional repo ·
security layer (Arch + Debian trackers, KEV, EPSS, confidence levels, exposure
through the graph, fast-track of fixes, `omarchy-cli security`) · paged release
view and linear release creation at 30k packages · edge-cached API reads ·
the factory: contributors' workers and staging, maintainers' approvals, the
project's rebuild, package requests and bumps as evidence · every pipeline
step a pulled job with a per-job token, no shared secret, GitHub only
releasing · signing inside the Worker · governance from a file, two roles ·
the cost estimate, the guard and the daily report · one worker image for
everyone, nobody approves their own package · the second agent (the audit
of a staged build, attached to its evidence) · the track record per group
on profiles · any agent provider on a worker · Worker tests inside workerd
(releases, the factory) · release diff (API, page, `pkg-repo diff`),
`releases --json --all`, the rollback button, databases kept for an
architecture a release did not touch, CVE metadata pruned by gc · releases
stored as deltas with checkpoints every 24th · OPR provenance (Omarchy's own
or AUR-synced, per package; the AUR count in stable on the overview) ·
security regressions block a promotion · promotion and rollback per
architecture · the client's hook preview, config example and ring check ·
`any` packages stored twice, counted on the overview · what statically linked
binaries embed (Go modules, cargo-auditable crates) in the manifest and the
index · OSV advisories against them · the ABI gate against an Omarchy
installation too · the verify job (served OPR objects checked and repaired) ·
the project's workers as three roles of one image (pool, review, community) on
its own host (`factory/host/`: setup, registration, compose) with a shared
package cache, and GitHub Actions for CI and the release only (the hosted
fallback worker is gone).

## Factory findings (2026-09-12)

- OPR aarch64 `omarchy` cannot be installed in a clean Arch Linux ARM container: `unable to satisfy dependency 'hyprland' required by omarchy` although `omarchy-packages-edge` serves `hyprland 0.56.2-3` for aarch64 (version constraint?). Anything depending on `omarchy` (flea) cannot be built for aarch64 until that is understood.
- The OPR ships most names for aarch64 too; what is missing there is mostly `-debug` packages, x86-only drivers/kernels/nvidia, proprietary binaries (dropbox, spotify, cursor, lmstudio…) and a few Omarchy tools (omakade, omapresent, omareel, omarchy-herdr, schist, flea, hey-cli, vi, pinta). Their PKGBUILDs are not in the AUR except hey-cli, vi, flea.
- An `any` package is stored once per architecture directory (sha256 is unique in the index), so an `any` PKGBUILD builds once per architecture.



## Findings to report upstream

What the pool's checks found in the projects it mirrors, written up for the
people who can fix them. Filing is a person's act: the maintainer who files
one links the issue here and moves the entry to *Reported*.

### Open

#### Arch Linux ARM: x86_64 binaries in aarch64-labelled packages

- **Where**: `extra` for aarch64, packages `gtpin`, `intel-oneapi-*`,
  `openai-codex-desktop`.
- **What**: their ELF binaries need `libc.so.6(GLIBC_2.2.5)` — a symbol
  version that exists only on x86_64 — so they cannot run on aarch64. The
  pool's ABI gate found them on 2026-09-12 (`abi` events for `edge`
  aarch64); `omarchy-cli check <pkg> --arch aarch64` reproduces it against
  an Arch Linux ARM base image.
- **Suggested report** (to https://github.com/archlinuxarm/PKGBUILDs/issues):
  > The aarch64 `extra` repository serves `gtpin`, `intel-oneapi-*` and
  > `openai-codex-desktop` whose binaries are x86_64 ELF objects (they
  > require `GLIBC_2.2.5`, an x86_64-only symbol version). They install but
  > cannot run. Found by an ELF-level check of every upgrade the repository
  > would apply to `menci/archlinuxarm:base`; happy to share the tool.

#### OPR: `opencode-1.1.51-1` in `rc` is signed by a key outside the published keyring

- **Where**: `https://pkgs.omarchy.org/rc/x86_64/opencode-1.1.51-1-x86_64.pkg.tar.zst.sig`.
- **What**: the signature does not verify against `builder/omarchy.gpg` of
  `omacom/omarchy-iso` (the keyring `omarchy-keyring` installs). The pool
  refuses the package on import (`sync` events, source `packages`, ring
  `rc`); a user with the published keyring would be refused it too.
- **Suggested report** (to https://github.com/omacom/omarchy-pkgs/issues):
  > `rc/x86_64/opencode-1.1.51-1` is signed by a key that is not in
  > `omarchy.gpg` as shipped by omarchy-iso/omarchy-keyring; pacman with
  > `SigLevel = Required` refuses it. Was it signed on a machine with a
  > different key, or has the keyring a key to add?

#### OPR: the same version is rebuilt with different bytes per channel

- **Where**: every package that reaches `rc` and `stable` through
  `bin/repo advance` and is built again for the target channel (76 of them
  on 2026-09-12, e.g. `wayfreeze-0.2.0-1`).
- **What**: `<name>-<version>` names two or three different archives with
  different checksums and signatures depending on the channel. Any mirror
  that stores one object per filename — the pool, or a pacman cache — keeps
  the first and rejects or misverifies the rest; a user moving from `edge`
  to `stable` gets a package pacman calls corrupted. The pool now pins the
  object it already holds and repairs signatures from the channel that
  serves those bytes (its `verify` job); the simpler fix is upstream.
- **Suggested report** (to https://github.com/omacom/omarchy-pkgs/issues):
  > Advancing a channel rebuilds packages instead of promoting the archives
  > already built for the previous one, so `wayfreeze-0.2.0-1` in `edge`,
  > `rc` and `stable` are three different files with the same name. Could
  > `bin/repo advance` copy the archive and its signature when the recipe
  > and the build inputs did not change (or bump `pkgrel` when they did)?
  > Filename-keyed caches and mirrors cannot tell the builds apart.

### Verified, nothing to report

- **Health summary showed an empty package count** in the pool's own
  journal (`( packages across N repos)`): the parser was relaxed on
  2026-09-12; every health event since names the count (e.g. `15663
  packages across 4 repos`). Ours, fixed.
