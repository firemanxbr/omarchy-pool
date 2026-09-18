# Architecture

omarchy-pool is a package repository for Omarchy built on three ideas: an
**immutable package pool plus an index** that represents complete releases, **signed
pacman databases generated from that index**, and a **thin client** that
understands releases. It began as a proof of concept answering exactly those three
questions — the evidence is kept in [`poc/RESULTS.md`](../poc/RESULTS.md) — and now
runs as the staging environment at https://omarchy-pool.org.

Packages are standard Arch `.pkg.tar.zst` archives produced by `makepkg`; they are never
modified. The deployment is a Cloudflare Worker + D1 + R2; the pipeline is a
queue of jobs in D1 that workers anywhere pull; GitHub hosts the code and
cuts the releases.

## The problem

Today `edge`, `rc` and `stable` are three complete directory trees (~275 GB each).
Promoting a release copies and re-uploads most of that data, so a bump takes
30–60 minutes even when almost nothing changed.

## The publishing layer

![Every source feeds one publishing layer: a package is stored once and indexed once, the rings are selections of the index, and pacman reads the databases beside the packages — one release model, one retention model.](diagram:publishing-layer)

* **Pool** — Cloudflare R2, one directory per source (`<source>/<arch>/<filename>`,
  `worker/src/r2.ts`), the way the mirrors lay out `extra/os/x86_64/`. A package is
  uploaded exactly once, whether it came from the Arch mirror sync or from an OPR
  build; two projects' builds of one filename with different bytes — Arch's
  `asusctl-6.5.0-1` and the OPR's, Arch Linux ARM's `libkrunfw` and Asahi's — are two
  objects in two directories, each served by its own repository section. Within one
  source a filename is one object: an upstream that rebuilds the same version with
  different bytes (the OPR does, per channel) keeps the object already stored. The
  rows of the index carry their key (`packages.r2_key`); the move from the earlier
  flat layout (`<arch>/<filename>`, one object per filename whichever source built
  it) was the one-time `relayout` job (`worker/src/routes/relayout.ts`).
* **Index** — Cloudflare D1. Every package with its full metadata (from `.PKGINFO`
  plus the ELF soname graph extracted by `pkg-extract`) and every release.
* **Releases** — a release is a pinned selection of package ids for one ring
  (`edge`, `rc`, `stable` — and `lab`, below). Promotion creates a new release for the target ring that
  points at the same selection: an index write, no bytes move. Rollback is the same
  write pointing at an earlier selection; history is append-only. Stored as
  **deltas**: what a ring serves now lives in one table (`ring_packages`), a
  release writes only what it changed against its parent (`release_deltas`), and
  the full membership is written out for a *checkpoint* — the first release of a
  ring, then every 24th, and any older release read by id (a pinned page, a diff,
  a rollback target), reconstructed from the checkpoint behind it plus the deltas.
  A release costs hundreds of rows, not thirty thousand (migration 0017).
  A selection holds **one row per source, name and architecture**: a package
  added replaces its own source's build of that name, never another source's —
  Arch Linux ARM's `mesa` and asahi-alarm's are two rows, each in its own
  database, and the order of the pacman include (`REPO_ORDER`, `worker/src/meta.ts`)
  is the only thing that decides between them, as it does between mirrors. A
  sync drops a name from its own source's rows (`remove_from`); a maintainer's
  `remove` drops it from every source.
* **Generated pacman databases** — for each ring and source the publisher renders
  `omarchy-<source>-<ring>.db` and `.files` in `repo-add` format and uploads them;
  the Worker signs them with its own OpenPGP key (a secret that never leaves
  Cloudflare, `worker/src/signing.ts`) and stores them **beside the packages** (`core/x86_64/omarchy-core-stable.db`). pacman
  reads the bucket's custom domain directly — each section's `Server = https://pool…/<source>/$arch`,
  the directory its database is in (the include, `worker/src/routes/setup.ts`, names
  it from the artifact's key) — and the only thing that differs between rings is the
  repository name. No worker, no redirect on the read path.

![A promotion is an index write: the target ring points at the same selection and its databases are rendered again. No package file moves; a rollback is the same write pointing back.](diagram:release-promotion)

### Index schema (D1)

| table | purpose |
|---|---|
| `packages` | immutable rows keyed by `sha256`; `manifest_json` holds the full manifest |
| `package_provides` / `package_requires` / `package_files` | normalized graph for queries |
| `package_components` | what a package's statically linked binaries embed — Go modules (`debug/buildinfo`), crates.io crates (`cargo-auditable`) — one row per module or crate, for advisory matching against language ecosystems |
| `releases` | `(ring, seq)` with `created_at`, optional `parent_id`, a note, the stored summary (`package_count`, `bytes`, `sources`) and `checkpoint` |
| `ring_packages` | `(ring, package_id)` — what each ring serves now; every read of a head |
| `release_deltas` | `(release_id, package_id, op)` — what a release added or removed against its parent |
| `release_packages` | `(release_id, package_id)` — the full selection of checkpoint releases only |
| `ring_heads` | `ring → release_id` currently served |
| `opr_packages` | per OPR package, where its recipe comes from (`omacom/omarchy-pkgs`, `.omarchy/package.json`): `source` local or aur, the AUR commit tracked, the last commit that touched it |

Migrations live in `worker/migrations/`.

### Index API (Worker)

| Route | Purpose |
|---|---|
| `PUT /api/v1/pool/:sha256?filename=` · `…/multipart` | pool upload (R2 verifies the sha256; multipart for large archives) |
| `POST /api/v1/packages?source=core` | index a manifest with its provenance |
| `POST /api/v1/packages/known` | which sha256s the index already has (the sync's diff) |
| `GET /api/v1/version` · `/status` | running release; service check measured now (index and pool reachable, timings) — what *online* in the dashboard header means |
| `GET /api/v1/releases/:ring` · `/history` · `/diff?from=&to=&arch=` | current release, package list, lineage. `?fields=summary` is small; full manifests are paged (`?arch=&limit=≤1000&after=<page.next>&release_id=` — keyset paging: each page names the row the next starts after, a walk of the `(name, repo_arch)` index rather than a sort and a skip per page; `offset=` still works for older clients; above 2000 packages an unpaged request is refused with 413, since a 15k-package ring with file lists exceeds one Worker invocation; the count comes from the release row, not a join); `include=files` returns each file list still gzip-compressed (`files_gz`, base64) and the reader inflates it — 500 decompressed lists of chaotic-aur games per page exceeded the Worker |
| `POST /api/v1/releases` | create / promote / roll back a release (a job's token); `arch` promotes or rolls back one architecture while the other keeps what the ring serves |
| `PUT /api/v1/releases/:id/artifacts/:kind?repo=` | store a rendered database beside the packages |
| `GET /api/v1/graph?targets=a,b&ring=stable&arch=` | dependency closure for the client's safety check — follows declared dependencies through *declared* provides (`package_provides.declared`, from `.PKGINFO`), as pacman does; the sonames a binary loads or ships never route the closure (a package bundling its own libstdc++ is not a provider of `libstdc++.so`) |
| `GET /api/v1/packages/:sha256/provenance` | the seal of an object: a synced package's upstream project and the keyring its signature was verified against; a factory package's chain — the evidence build, the audit, the approval, the maintainer's recipe and the project's build of it — and the attestation the pool wrote next to the object (`<filename>.provenance.json`, an in-toto Statement, `.sig` by the pool's key; `routes/seal.ts`, written when the project's build completes, removed with the object by GC) |
| `GET /api/v1/security?ring=&arch=` · `PUT /security/advisories` · `PUT /security/matches` | open advisories on what a ring serves (per package: confidence, severity, KEV/EPSS, rings already serving a clean version, how many packages depend on it or load one of its libraries); the writes are the Security workflow's |
| `GET /api/v1/search?q=` · `/package/:name[/files]` | search within a ring; a package's versions per ring, manifest, forward edges (declared dependencies and loaded sonames resolved to providers) and reverse edges (declared, or by loading one of its libraries) — the package page and, later, CVE propagation |
| `GET /api/v1/pool/unreferenced` · `POST /api/v1/pool/gc` | retention: what the last N releases do not reference |
| `GET /api/v1/factory` · `POST /factory/{requests,enqueue,claim,jobs}` · `/factory/tasks/:id/{heartbeat,complete,fail,cancel,approve,reject}` · `/factory/tasks/:id/artifacts/<file>` · `/factory/{register,packages,workers,workers/self,maintainers,review,approvals,trust,me}` · `GET /api/v1/users/:login` · `GET /api/v1/cost` | the factory's brain: package requests, build tasks with leases, the workers pulling them, contributors and their packages, maintainers' approvals, jobs queued by hand, the daily cost estimate ([factory/README.md](../factory/README.md), [GOVERNANCE.md](GOVERNANCE.md)) |
| `POST /api/v1/events` · `GET /api/v1/events` · `GET /api/v1/stats` | activity log and the dashboard's data |
| `GET /` | the dashboard — three doors, one per audience: `/` the Pool (Omarchy users: rings, the three steps of pacman, coverage; no account), `/factory` the Factory (contributors: how a package gets in, registering, workers, builds), `/pipeline` the Pipeline (everyone: the journal as it happens, review throughput, and the operations maintainers act on). `/docs` is one interactive hub over the chapters; `/packages`, `/package/:name`, `/security`, `/status`, `/journal`, `/review`, `/user/:login` are the detail pages, one link away. Every page is a string with a `<script>` that reads the API; the diagrams are inline SVG drawn in `worker/src/pages/diagrams.ts`, the charts in `charts.ts` |

pacman never talks to the worker. The worker never resolves dependencies; it
serves data. Decisions are made by the publisher (`pkg-repo`) and the client.

### Staging pipeline (pulled jobs)

Every row below is a **pulled job**: the Worker's cron queues it in
`build_tasks` on this schedule (`JOB_KINDS`), a project worker runs it with a
per-job token, and a maintainer queues the same by hand (`pkg-repo job`).
Nothing of the pipeline runs on GitHub Actions. The project's workers are
three roles of one image ([factory/README.md](../factory/README.md) *Three
roles*): *pool* workers take the rows below, *review* workers the project's
`build` and the `audit`, shared *community* workers the contributors' builds
— two of each, one per architecture, on the project's host (RUNBOOK, *The
Studio host*). A community worker is a pair: a **broker** that holds the
worker's token, the agent key and a GitHub token and only receives,
processes and answers, and a **builder** born with nothing that builds one
task and dies (`factory/bin/broker`; SECURITY.md, *Isolation*). A project
worker is its own broker: the build containers it starts hold nothing and
reach the agent through `agent-proxy`.

| Job | Schedule | What it does |
|---|---|---|
| `sync` | every 3 hours, one task per architecture, one release per ring | `pkg-repo sync` for every source in its table — Arch `core`/`extra`/`multilib` (x86_64, from `mirror.omarchy.org`), Arch Linux ARM `core`/`extra`/`alarm` (aarch64), chaotic-aur (x86_64, optional repo, `--defer-to` the others so Arch and the OPR own any shared name) into `edge`; the OPR's `edge` channel into `edge` too — its `rc` and `stable` channels are not an input: the OPR reaches `rc` and `stable` by the pool's evidence like every source (until 2026-09-16 they were synced straight into the matching rings, the one source that skipped the gates); a filename the pool already holds with different bytes keeps the stored object, noted in the journal — every package's upstream signature verified against that project's keyring before it enters the pool; then render the rings that changed (a sync that changes nothing creates no release; a release scoped to one architecture keeps the other's databases and artifact rows from its parent — `unchanged_arches` in the response — so an aarch64 sync no longer re-renders the 15k-package x86_64 `extra`) |
| `promote` | by evidence: edge→rc queued by the last sync of a tick (a 12-hourly safety net behind it), rc→stable attempted every 3 hours; or manual, whole or one architecture (`arch`) | evidence-driven (below): fresh health + ABI of the source ring on both architectures → gate → index write → render → health of the target → automatic rollback if that fails |
| `health` | daily, per ring and architecture | real pacman per ring and architecture: `-Sy`, list, a sample per repository downloaded and signature-verified (the first, the last, a few at random; eight for the OPR) → `health` event |
| `gc` | weekly | delete pool objects the last 3 releases of every ring do not reference (7-day grace for imports in flight); prune the membership of releases outside retention and CVE metadata no advisory has mentioned for 90 days |
| `security` | every 3 hours | `pkg-repo security`: the Arch Security Tracker (exact matches on Arch's versions), the Debian Security Tracker (same upstream projects, only for CVEs Arch has no advisory for, `name-version` when Debian names a fixed version newer than ours, `name-only` while still open; names whose versions are an order of magnitude apart are treated as different projects), CISA KEV and EPSS, matched with the real `vercmp` against every object the rings serve and stored in the index; OSV for what the served packages embed (`package_components`: the Go modules and crates.io crates a statically linked binary was built with — one `querybatch` per 1000 components, records cached, each hit an exact advisory against the Arch package that embeds it, `fixed` naming the module's fixed version); then the **fast-track**: a package with a confident open advisory (exact or name-version, medium or worse, or exploited in the wild) in `rc`/`stable` whose clean newer version `edge` already serves is pulled in as one release without the soak, rendered, health-checked on both architectures and rolled back if that fails |
| `enqueue` | by hand only (`pkg-repo job enqueue`) | the sizing recipes on `main` reconciled with what the factory built — the repository holds no package recipes since 2026-09-17, so the scheduler no longer runs it |
| `rollback` | by hand only | a ring pointed at an earlier release, both architectures re-rendered |
| `verify` | weekly (Saturday 03:00 UTC), or by hand | does what the pool serves verify? Every OPR object of every ring and architecture downloaded and checked: the bytes are the ones the index names, the `.sig` beside them is Omarchy's signature of those bytes. What is wrong is repaired — the right signature from the upstream channel that still serves the bytes, the ring re-pinned to the object the pool actually holds (indexed from the bytes if the index never saw them), rendered — and what no channel serves any more is reported for a replacement (`verify` event, `pkg-repo verify --repair`) |
| `trial` | when the project's review build is staged, or by hand (`pkg-repo job trial --param task=<build>`) | the build into the lab and a real pacman on it: the staged packages go into the pool under the factory's directory, pinned into the `lab` ring (never a promised one), the lab rendered; then `tests/trial.sh` runs a clean container of that architecture with the include of `--ring lab` — the lab's sections above `edge`'s — and installs the packages for real (dependencies from `edge`, hooks run, `pacman -Qkk` on the files), checking each came from the lab. The transcript is attached to the evidence (`trial.log`), a `trial` event records it, the Review page shows *installs* or what stopped it. Evidence for the maintainer, never a decision. A pool worker's job |
| `audit` | when a community build is staged | the second agent ([Governance](GOVERNANCE.md#learn)): a project worker whose owner set an agent key (Anthropic, OpenAI, Gemini or xAI) reads the staged PKGBUILD, log and `.PKGINFO`, asks its model for a structured review (`factory/bin/audit-pkgbuild`, `factory/prompts/audit.md`) and attaches `audit.json` / `audit.md` to the evidence; the Review page shows the verdict. A review worker's job |
| `build` | on a request (at once, in the shared queue), on a new upstream release, and when a maintainer presses *Build by the project* | a package built in a fresh container through the gate (checksums, shellcheck, namcap ×2, files, metadata, `check()`, smoke): community trust on a contributor's or a shared worker into the owner's staging workspace as evidence; project trust (`review:<task>`) on a worker two maintainers vouched for, the project's agent writing its own recipe from that evidence, into `staging/@project/` for the audit, the trial and the approval |
| `publish` | on approval | carries the project's approved build into `edge` as source `factory`, signed by the pool; when the trial passed, into rc and stable too (the fast lane) |
| audience (`src/audience.ts`) | once a day, 00:30 UTC | taken by the Worker itself from the account's request analytics, both pool hosts in one query: distinct addresses that fetched a ring database the day before, per ring and per architecture, as an `audience` event — the Pool page's *machines on the pool*; nothing per request is kept |
| metrics snapshot (`src/metrics.ts`) | every 30 minutes | taken by the Worker itself, no job: the pool's jobs of the last 7 days (runs, failures, worker minutes, per kind), builds, workers alive, pool totals and ring sizes, as a `metrics` event; the dashboard's charts and jobs table read from it |
| worker cron trigger | every 10 minutes | the pool's own scheduler: queues the jobs above when due, requeues expired leases, applies `factory/MAINTAINERS.toml`, reads the OPR's recipe repository for provenance (05:15, `src/provenance.ts`: per package, Omarchy's own or AUR-synced, the upstream AUR commit, the last commit), checks upstreams for bumps (05:45), estimates the bill (06:30), logs pool jobs waiting for a project worker; see RUNBOOK |
| `ci.yml`, `e2e.yml` | every pull request | fmt, clippy, tests and the worker typecheck on x86_64 and aarch64; real pacman end to end through a local worker |
| `release.yml` | when a maintainer decides (`gh workflow run release.yml`, or the Actions page) — main takes merges as they are ready, one release carries them all | CI + E2E again on main's head, next version from the last tag (`v0.0.1`, `v0.0.2`, …), binaries for both architectures, GitHub release with notes from every pull request since the last tag, the worker image, `wrangler deploy` carrying `POOL_VERSION` — the dashboard shows what is running |

Every step posts an event; https://omarchy-pool.org renders them.
Nothing of the pool's operation runs on GitHub besides CI and the release
(since 2026-09-17: no recipe pull requests, no dispatched workflows — a
GitHub outage stops the code from changing and nothing else). No worker
runs on GitHub: the project's six run on its own host (RUNBOOK, *The
Studio host*).
Operations, trust model and the kill switch are in [RUNBOOK.md](RUNBOOK.md).

#### The lab: tried before it is promised

`edge`, `rc` and `stable` are the promise: whichever source built a package,
it enters `edge` signature-verified and reaches `rc` and `stable` by evidence
— the same gates for Arch's packages, Arch Linux ARM's, the Asahi fork's, the
OPR's and the factory's. **Zero trust**: the pool verifies and validates; it
does not choose whom to believe. The **lab** is the fourth ring, beside the
three and never on their path: nothing in it is promised, no sync targets it,
no promotion comes from it or goes into it (`POST /releases` refuses both).
What it is for:

* the factory's builds land there first — the review build of an approved
  package publishes into the lab, and the `trial` job installs it with a real
  pacman in a clean container against `edge`, runs the hooks, checks the ABI,
  and records the transcript beside the audit for the maintainer who decides;
* any object the pool holds can be pinned there, from any source, to be tried
  in a combination (the Asahi fork's `mesa` under `edge`'s `hyprland`, say);
* a machine that wants to try it is one command away: `--ring lab` writes the
  lab's sections **above** `edge`'s, so what is being tried wins by order and
  its dependencies resolve from `edge`; a lab with no release yet is `edge`.

A build leaves the lab for `edge` by a maintainer's approval (the `publish`
job), never by promotion; retention keeps the lab's last releases like any
ring's. **The fast lane:** a build the trial installed goes to `rc` and
`stable` with `edge` — the publish job's token opens those rings only when
the trial's verdict was `ok`, and a `fast-track` event records it — as a
security fix does (the security layer's own fast-track). The maintainer
decided the build; the evidence decides the speed.

#### Promotion by evidence, not by calendar

![The promote job — edge → rc right after the sync that changed edge, rc → stable on the second green check in a row, attempted every three hours. Evidence in, a gate event out, and the target ring checked again before the promotion stands.](diagram:promotion-gates)

A promotion happens when the recorded evidence says the source ring is good
— and is attempted when that evidence can exist: the sync that changed
`edge` queues `edge → rc` (routes/factory.ts), `rc → stable` is attempted
every three hours (scheduler.ts) — and is undone automatically when the
target ring turns out not to be:

1. **Evidence.** On both architectures, a real pacman syncs the source ring and
   downloads a signed sample of every repository (`health` event), and
   `omarchy-cli` runs the ELF-level safety check on every upgrade the ring
   would apply to two reference systems (`abi` event, blockers = unsatisfiable
   symbol versions): the official Arch / Arch Linux ARM base image, and — on
   x86_64 — an **Omarchy installation**, the ISO's package set
   (`omacom/omarchy`'s `omarchy-base.packages` plus the archinstall base)
   installed from `stable` into a container and cached for a week
   (`tests/omarchy-rootfs.sh`, ~900 packages) — what users actually have.
2. **Gate** (`pkg-repo gate`). Per architecture: the latest health of the source
   ring is recent and not an error; health did not keep failing (three
   errors in a day block — a failure the next check recovered from stays in
   the report as evidence); the **soak** is met — `soak_checks` green health
   checks in a row recorded since the source ring's current release: one
   for `edge → rc` (the check the promote job just ran), two for `rc →
   stable` (the attempt three hours earlier and this one), so `stable` is
   about six hours behind `rc` and never waits for a calendar; a recent ABI
   check found no blocker; and the security
   layer reports no **regression** — a package the target serves clean today
   that the source would replace with a version under an open advisory the
   tracker is sure about (exact match, medium or worse, or exploited in the
   wild). Clean means examined: a version indexed before the component
   scan existed has no embedded components and no OSV advisories, and
   counts as clean for nothing an OSV advisory is about. The fast-track
   pulls fixes forward; the gate never pushes a known hole. A ring with nothing rendered for an architecture is not evidence
   against it. If the target already serves the source's head there is
   nothing to promote. The verdict and its reasons are a `gate` event.
3. **Promote, render, verify.** The index write records the previous head; the
   databases are rendered and signed for both architectures; the target ring gets
   the same health check on both.
4. **Automatic rollback.** If that health check fails, the ring is pointed back at
   the previous release (another index write), re-rendered, and a `rollback` event
   says which release failed and which one was restored. Otherwise a `promote`
   event confirms it.

Stable moves without a human: the evidence is the reviewer, and a maintainer
who disagrees queues a rollback.

![release.yml — merges land on main as they are ready; a maintainer cuts the release that carries them; versions start at v0.0.1 and grow one step at a time, and the dashboard shows what runs.](diagram:release-pipeline)

#### Security: advisories with confidence, exposure through the graph

Every object a ring serves is matched against public advisories (`security.yml`,
tables `advisories`, `cve_meta`, `package_advisories`). Each match carries how
sure we are — **exact** (the Arch tracker knows Arch's version), **name-version**
(Debian fixed the same upstream project in a version newer than ours),
**name-only** (still open upstream; possibly affected) — and each CVE whether it
is exploited in the wild (KEV) and how likely exploitation is (EPSS). Arch is
authoritative: Debian only fills CVEs Arch has no advisory for, and a name whose
versions are an order of magnitude apart from Debian's (`keystone`: assembler vs
OpenStack) is treated as a different project.

Fixes travel faster than features: `pkg-repo fast-track` pulls a clean version
into `rc`/`stable` as soon as `edge` has it, with the same render → health →
rollback safety net as a promotion, and `omarchy-cli security` /
`omarchy-cli upgrade --security-only` let a machine apply just those.

Exposure is not stored: the index derives it from the same dependency and soname
graph the package page draws — a package is *exposed* when it declares a
vulnerable package or when one of its binaries loads a library the vulnerable
package provides (the stronger evidence). The Security page shows both per ring,
the package page shows the chain, and the graph marks the nodes.

### Architectures

A package row records `repo_arch`, the architecture of the upstream repository it
came from; it is the pool directory (`x86_64/…`, `aarch64/…`) and, with the name,
the replacement key inside a ring. `any` packages are per-upstream builds: Arch's
and Arch Linux ARM's `python-foo-1.0-1-any` are different objects in different
directories. A ring holds both architectures; `render --arch` emits one database
per source for that architecture.

## Extraction (`crates/pkg-extract`)

Out-of-band: the archive in the pool is byte-for-byte what `makepkg` produced.
For each package the extractor merges `.PKGINFO` with the ELF facts of every
shipped object (`DT_SONAME`, `DT_NEEDED`, `.gnu.version_r`) into a
`PackageManifest` (`crates/pkg-manifest`). Symbol versions collapse to the highest
per `(soname, namespace)` since `GLIBC_2.34` subsumes `GLIBC_2.14`.

The manifest carries everything `repo-add` puts in a `desc` file (`pkgbase`,
`builddate`, `packager`, `makedepends`, `filename`, …) so databases can be rendered
from the index alone.

Statically linked binaries reveal nothing through sonames, so the extractor
also reads what they embed (`components`): the Go modules a Go binary was
built with (`debug/buildinfo`, present in every Go binary since 1.12 — the
`modinfo` string between its sentinels, replacements applied) and the crates a
Rust binary was built with when the packager used `cargo-auditable` (the
`.dep-v0` ELF section, zlib-compressed JSON; Arch's own Rust packages do not
carry it, the factory's recipes could). Named the way OSV names them (`Go`,
`crates.io`), one index row per module or crate, shown on the package page as
*Embedded libraries*.

## Database generation (`crates/pkg-repo`)

Renders a release into `repo-add`-compatible archives:

* `<repo>.db.tar.gz` — one `<name>-<version>/desc` entry per package;
* `<repo>.files.tar.gz` — the same plus a `files` entry;
* detached GPG signatures (`.sig`) for both.

Validation: an Arch container with `Server = https://pkgs.<domain>/$repo/os/$arch`
runs `pacman -Sy` and `pacman -Sp <pkg>` against the generated database. See
[TESTING.md](TESTING.md).

## Safety check (`crates/pkg-check`)

* `local::LocalDb` — the pacman local database, read-only: installed versions and
  `provides`.
* `abi::SystemAbi` — the shared libraries actually on disk and the symbol versions
  they define (`.gnu.version_d`).
* `check` — for every package the release would install, each `requires` rule is
  classified: satisfied by the plan itself, by an installed library/package, a
  **warning** (pacman must resolve it from another repository; a library that is
  not on disk at all is almost always optional to one binary) or a **blocker**
  (a library this system has, but too old — it does not define the symbol
  version the package needs).

## Thin client (`crates/omarchy-cli`)

![The client decides; pacman still performs the installation.](diagram:thin-client-install)

The client drives pacman rather than replacing it. What it adds:

* knows which **release** the machine is on and what the ring currently serves
  (`status`, `upgrade` pins pacman to that release);
* **safety check** before an out-of-band install: fetches the dependency subgraph,
  reads `/var/lib/pacman/local`, and refuses when a library on the system does not
  define a symbol version the package needs — the case that today produces a
  broken partial upgrade;
* **hook preview**: `check` and `install` list the libalpm hooks pacman
  would run for the transaction (`mkinitcpio`, `glib-compile-schemas`, …) —
  the `.hook` files of the system (`/usr/share/libalpm/hooks`,
  `/etc/pacman.d/hooks`, the latter overriding by name) matched against the
  planned packages by name and by the files they ship, fetched from the
  ring. Read-only: pacman runs them; `poc/crates/pkg-hooks` parses and
  matches;
* mirror discovery and release notifications come from the index, not from
  `pacman -Sy` polling. A ring holds every source's build of a name; the
  client takes one per name in the pool's `source_order` (the release and
  graph views carry it — the include's order, what pacman takes from the
  first section that has the name) and hands pacman the object's own
  address, `<pool>/<source>/<arch>/<filename>`;
* **MCP** (`omarchy-cli mcp`): the same answers as tools for an assistant on
  the machine — `status`, `check`, `info`, `search`, `list`, `security` —
  over stdio (JSON-RPC, one message per line), read-only; installing and
  upgrading stay with the person at the keyboard
  ([`docs/omarchy-cli-mcp.md`](omarchy-cli-mcp.md)).

`vercmp` is a byte-for-byte port of `alpm_pkg_vercmp` so the client and pacman
always agree on ordering. Settings live in `/etc/omarchy-cli/config.toml`
([`docs/omarchy-cli.config.toml`](omarchy-cli.config.toml) is the annotated
example); the ring and the architecture are checked before any request.

## Not on the product path

`poc/crates/pkg-store` (a redb state store plus a journaled, crash-safe filesystem
transaction — the engine that would let the client stop shelling out to pacman)
is built and tested but not wired in: the thin client did not need it.
(`poc/crates/pkg-hooks`, once only the types, now parses and matches `.hook`
files for the client's hook preview; running them stays with pacman.) They
stay in the workspace so they keep compiling; see
[`poc/README.md`](../poc/README.md). Open work is in [`TODO.md`](../TODO.md).
