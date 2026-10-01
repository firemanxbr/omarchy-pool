# The factory

Builds the packages no upstream ships — for the architectures the pool serves
but nobody else covers (today: what the OPR only builds for x86_64, on
aarch64), and, later, the AUR names Omarchy installs. It lives in this
repository for now; it is designed to move out (see *The contract* and
[docs/MIGRATION.md](../docs/MIGRATION.md)).

The pool is the brain. GitHub holds PKGBUILDs and runs CI; it orchestrates
nothing. Workers run on the maintainers' hosts, and pull: contributors
submit packages and use the pool's workers, and run none (*Whose compute*).

Maintainers never ship a
contributor's bytes — *we do not use what you built, we learn from it*
([Governance](../docs/GOVERNANCE.md)). A contributor's build is
evidence: the recipe, the log, the manifest that let a maintainer rebuild,
verify and attest the package faster and approve it with more confidence.

![The pool is the brain; workers are ephemeral, live anywhere and pull. A contributor's build is evidence, staged for the audit and the trial; the pool's own build of an approved package is what reaches the rings.](diagram:factory-loop)

## A package's life

1. **Someone requests it.** A contributor signs in and asks, on the
   Factory's request card (`/factory`): the project's URL (a GitHub
   repository or its release tarball — for a project elsewhere, its home
   page and the release's source and version; the card reads a repository
   on GitHub, GitLab or Codeberg and fills in the licence, the description,
   the name and, off GitHub, the release), a name — checked as it is typed,
   by the request's own rule —, one line of description, the licence
   (SPDX), the architectures, and four things they confirm. The pool
   checks all of it — a blocked contributor, a name or a project already
   in the pool, an upstream that ships the name, a source that does not
   answer — and only then reserves the name, in one statement, and writes
   the request **once** to the record,
   `factory/<name>/<id>/request.json` in the pool bucket with the pool's
   detached signature, public and immutable (`worker/src/record.ts`).
   Nothing about a request lives on GitHub. The build starts by itself,
   in the shared queue: the best idle worker of the architecture, on the
   pool's hosts, with its agent. The four things, as the form asks them:
<!-- checklist -->
2. **Does someone ship it already?** The pool is asked first. If Arch, Arch
   Linux ARM or the OPR ship the name for an architecture it enters the pool's
   cycle as it is; the factory refuses to build that architecture
   (`override:true` exists for the deliberate case). It only builds what is
   missing.
3. **The PKGBUILD is drafted, not written**, when none is given:
   `factory/bin/draft-pkgbuild` in the worker reads the repository (metadata,
   latest release, build files, README) and asks the owner's agent for the
   PKGBUILD following `factory/prompts/pkgbuild.md` — `factory/bin/agent.py`
   speaks to Anthropic, OpenAI, Gemini or xAI by the key set
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`;
   `FACTORY_MODEL` picks the model) — or runs Claude Code in print mode on
   a Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude
   setup-token`; the dashboard's *Run a worker* page has the steps) — the
   worker owner's key, never the pool's; without one a template covers Rust,
   Go, CMake, Meson, autotools and prebuilt release binaries. `updpkgsums`
   fills the checksums and `namcap` lints, in the container.
4. **It is built before anyone reviews it — and it passes the gate.** The
   worker builds it in its fresh container; a failure feeds the log back to
   the drafter for a corrected PKGBUILD — three attempts. Then the gate
   (*The gate*, below): the checks every package must pass, run by the
   worker on what it just built, the transcript in `tests.log`, the verdict
   in `vet.json`. A failing gate is a failed build (final, never retried
   by the pool; the drafter gets one turn with the verdict as the log). The
   package, the PKGBUILD, the log and the gate land in the contributor's
   staging workspace as **evidence**, and the evidence — never the package
   — is copied to the record, `factory/<name>/<request>/build-<task>/`,
   signed; nothing is published.
5. **The second agent reads it.** Staging the build queues an `audit`: a
   project worker whose owner set an agent key reads the PKGBUILD, the log
   and the `.PKGINFO`, asks the model for a structured review
   (`factory/bin/audit-pkgbuild`, `factory/prompts/audit.md`) and attaches
   `audit.json` / `audit.md` to the evidence. The Review page shows the
   verdict (`ok`, `warn`, `block`); nothing acts on it, the maintainer does.
6. **A maintainer claims it — never their own package.** On the Review
   page, a maintainer (`factory/MAINTAINERS.toml`) claims a package that is
   ready (*Build by the project* on a build's page is the same door): the
   project builds it again on a review worker, with the agent the maintainer
   chose — the worker the claim pins. The workspace puts the factory's build
   beside the rebuild: the request as checked, both PKGBUILDs with the lines
   that differ lit, both logs. A claim can be let go (*Release claim*) by the
   maintainer who made it or another, while a rebuild of it is queued or
   running; every rebuild of the claim stops, one already staged too, and
   the package waits for a claim again. The words are the same on every
   page: a package built and waiting for a claim is *ready for review*; from
   the claim until the decision — the rebuild queued, running or staged —
   it is *in review*, on the Factory's line, on Review and on the package's
   page alike — its chip and its Review stage, while a newer version builds
   beside the claim too; the Factory's line files a package by Review's own list. A
   maintainer may also stop the round with a note: *Request changes* sends it back to the
   factory and the name stays the requester's; *Reject* frees a request's
   name. One review covers the package: it starts once every architecture
   requested is built or *not supported*, and the project builds each built
   one again. A review worker of each architecture takes its task (`review:<task>`): the project's
   agent gets the request and the contributor's PKGBUILD, log, gate and
   audit as the lesson — `draft-pkgbuild --evidence` — and writes the
   project's own recipe from the project's sources; the same gate runs;
   the packages, the recipe, the log, the gate go to the project's staging
   space (`staging/@project/…`) and the evidence to the record; its own
   audit is queued — and its **trial**: a pool worker of that architecture
   puts the package into the pool under the factory's directory and pins it
   into the **lab** (the fourth ring: nothing there is promised or
   promoted), renders the lab, and a real pacman in a clean container
   installs it from the lab above `edge` (`tests/trial.sh`): dependencies
   from `edge`, hooks run, files verified. The transcript goes beside the
   evidence (`trial.log`); the Review page shows *installs* or what stopped
   it. Nothing is published yet.
7. **A maintainer approves the project's build.** With the project's
   evidence in front of them (the workspace shows the factory's build and the
   rebuild side by side), a maintainer — not the owner — approves, after a
   confirmation, with their passkey in the browser (#271: no token approves
   or blocks). Every decision is a record the pool signs and a journal line
   with who, the door (`via`: the web or a token) and the agent that rebuilt
   each architecture (what its review worker ran when it staged it). Review's
   decisions — a claim, approve, request changes, reject, a release, an
   adoption that takes a registration — are beside the request, at
   `factory/<name>/<request>/decision-<time>-<word>-<id>.json`; a block of a
   package and its lift at `factory/<name>/<request>/decision-<time>.json`;
   a withdrawal at `factory/<name>/decisions/<time>-withdrawn.json`; a
   contributor's block and its lift at `contributors/<login>/`. Each is
   written once and never rewritten, and a decision is taken once: a second
   one on the same builds at the same moment is refused. What takes an
   approval back is a decision of its own, on the record: a block, or the
   withdrawal a maintainer writes a reason for. The approval is one decision on
   the record for the package — a review covering every architecture the
   project built again, one that never built named *not supported* — and a
   `publish` job per architecture: a project worker fetches the staged
   packages with the job's token, publishes them into `edge` as source
   `factory` (the pool signs), renders, and the brain marks the
   registration `published`, links the approval to the build and writes
   the seal next to the object. **The fast lane:** when the trial installed
   the build (its verdict was `ok`), the publish job pins the same objects
   into `rc` and `stable` as well, renders them, and records a `fast-track`
   — the maintainer decided the build, the evidence decides the speed; a
   build whose trial did not run or did not pass reaches `rc` and `stable`
   by promotion like everything else. Only the sizing recipes
   (`factory/sizing`, benchmarks) take the `enqueue` door without a staged
   build; every package comes in through a request.
8. **After that: bumps are evidence too.** Once a day the brain asks GitHub
   for each approved package's latest release and queues a community build
   from the contributor's staged PKGBUILD with `pkgver` moved to the tag
   (`bump:<task>@<tag>`) — for the owner's worker first, for any `--shared`
   worker after 14 days — and a maintainer reviews it like the first time.
   30 days without a build and the package is *unmaintained* until someone
   takes it (docs/GOVERNANCE.md) — a maintainer, from Review's *No
   maintainer* tab or the package's page: *Adopt*, one door for both, makes
   them its maintainer in the pool, and the registration and its bumps
   become theirs; another maintainer reviews those bumps (Adopt on a synced
   package names its maintainer in the pool and nothing else). There is no
   second path: the project's own recipes left the repository on
   2026-09-17, and nothing in the factory's operation goes through GitHub
   Actions, issues or pull requests.
9. **A worker builds it.** Any worker of that architecture claims the task,
   holds a lease, builds in its fresh container, publishes the result
   into `edge` as source `factory` — the pool signs it with its own key —
   and renders the edge databases. From there
   it is a package like any other: health checks, the soak, `rc`, `stable`,
   the security layer, `omarchy-cli`.
10. **If it fails**, the task returns to the queue with the log tail; after
   three attempts it is marked failed and the build's page shows why. A
   worker that dies mid-build loses its lease and the task is requeued by the
   pool's scheduler within ten minutes.

The asker's own page follows the package — one name, one registration —
in its own words: `registered`, then `waiting` or `building`, `staged`
when the worker hands the evidence in, a maintainer's decision
(`approved`, `rejected`) and `published` once the project's build is in
edge — `unmaintained` after 30 days without a build;
`GET /api/v1/factory/packages` lists every request and where it stands.
Beside that word, each architecture's own, its *target*: `waiting`,
`building`, `built`, `not supported`, `reviewing`, `reviewed`,
`approved`, `published`. The package's word follows the builds, not the
last worker to speak. While any build of the name is staged for a
maintainer, a failure on the other architecture leaves it `staged` and
writes what that build ran into in its detail; while the other
architecture still builds it stays `building` or `waiting`; only when no
architecture built does a failed build put it back to `registered` with
the reason — the request back with its owner.

## One name, one package

A package is its name. `marcelo` is one package, requested once; x86_64
and aarch64 are two targets of it — two artifacts, each built on a worker
of its architecture. The request reserves the name the moment it is sent,
in one statement: two requests for one name at once — a new name, or one
that was free — and one of them has it. A rejection frees the name, and
anyone may request it again; a package already in the pool keeps it, and
what was rejected is the new version. A contributor's block frees none of
their names. The builds run per architecture: one that fails after the
tries it had is *not supported*, and the others go on to the review; if
none builds, the request goes back to its owner. An architecture already
in the pool stays where it is served when a build of its next version
fails: that failure is the new version's. One review covers every
target, as each architecture stands now and at one version: the project
builds each supported architecture again on its review workers — never an
older build of an architecture whose newest one failed — and one decision
— approve, request changes, reject — covers them all, as a withdrawal or a
block of it does later; what it approved is what
the publish jobs, one per architecture, carry into edge. A block covers
the package on every architecture and every ring, withdraws the review it
stood on, and sends the package back to the factory. The decisions made
per architecture before this rule (migration 0036) were merged into the
reviews they were; the rows stay on the record as they were written.

## The gate

What the factory asks of every package, on both sides of the review —
the contributor's build and the project's — run by the worker in the
container that built it (`factory/worker/omarchy-build-worker.sh`,
`vet_package`), after the checks the omarchy-aur-factory runs. `fail`
fails the build; `warn` is for the audit and the maintainer to weigh.

| Check | What it asks | fail when |
|---|---|---|
| checksums | every source pinned (`updpkgsums` fills them) | a `SKIP` for a source that is not a VCS |
| shellcheck | `shellcheck --shell=bash` on the PKGBUILD (SC2034, SC2154, SC2164 excluded: makepkg's own) | an error |
| namcap-pkgbuild | `namcap PKGBUILD` | an `E:` |
| namcap-package | `namcap -m -i` on every built package: dependencies the ELF scan finds (glibc excepted), sonames, permissions, paths, `$srcdir` leaks, the licence file — `unused-sodepend` on the dynamic loader is the linker's and not weighed | an `E:` other than an ELF under `/opt` |
| namcap-libmap | namcap found no package for libc itself: its library map is blind on this worker, so a missing dependency passed unseen — the fix is on the worker (`namcap_sees_this_arch`), and the evidence is thinner | never (a warning, five points of the score) |
| prebuilt-debug | a `-debug` split of a recipe without `build()` — the pool builds with `!debug`, so only a recipe that turns it on gets here | the split exists |
| files | `pacman -Qlp`: only `/usr`, `/etc`, `/opt` | anything under `/usr/local`, `/bin`, `/sbin`, `/lib`, `/home`, `/tmp`; a `.la`; an empty package |
| metadata | `pacman -Qip`: `pkgdesc`, `license`, `url` | no description or licence |
| check | a `check()` running the upstream tests, or a comment saying why not | never (a warning) |
| smoke | `pacman -U` in the fresh container, then every binary the package puts in `/usr/bin` started once (`--version`, then `--help`) | the install is refused, or a binary cannot start (a missing library, exit 126/127, a signal) |

shellcheck comes from pacman where it exists and from the pinned static
release (`SHELLCHECK_VERSION`, checksum verified) on Arch Linux ARM, which
does not ship it; without it the gate says so and goes on. The audit (the
second agent) reads `tests.log` beside the PKGBUILD and the log, so it
weighs what the gate found instead of rediscovering it; the Review page
shows the gate's verdict next to the audit's.

## Contribute a package

You have something to package for Omarchy. No permission needed, and
nothing to run: you request the package, it builds on the pool's hosts (its
maintainers provide them; contributors do not run workers), and the result
waits in your staging workspace for a maintainer.

```bash
API=https://pkgs.omarchy-pool.org/api/v1

# 1. Who you are — a GitHub token is used once to read your login and never stored
#    (a fine-grained token with no permissions, made for this; never `gh auth token`).
curl -s -X POST $API/factory/register -H 'content-type: application/json' \
  -d "{\"github_token\":\"github_pat_…\"}"
#    → {"login":"you","token":"omc_…"}   keep it: export OMC=omc_…

# 2. Request the package: the pool checks nobody ships it, that the source answers, and writes the request to the record.
curl -s -X POST $API/factory/packages -H "authorization: Bearer $OMC" -H 'content-type: application/json' \
  -d '{"url":"https://github.com/you/project","description":"What it does, one line","license":"MIT",
       "checklist":{"official":true,"license":true,"unshipped":true,"evidence":true}}'
#    optional: "name", "arches"; for a project not on GitHub: "source" (the release tarball) and "version"
#    → {"package":…,"request":{"id":12,"record":"https://pool.omarchy-pool.org/factory/<name>/12/request.json",…},
#       "build":{"tasks":[57],"queue":{"aarch64":{"position":2,"total":3}},…}}   — queued at once, in the shared queue

# 3. Build it again, after a failure or a fix (the request above is already in the shared queue).
curl -s -X POST $API/factory/packages/project/build -H "authorization: Bearer $OMC"

# 4. Follow it.
curl -s $API/factory/me -H "authorization: Bearer $OMC"       # your packages, workers, tasks, staging quota
```

What happens: a worker on the pool's hosts claims your task, builds it in a
fresh container — from the `PKGBUILD` in your repository if you named one,
else a PKGBUILD **drafted** from the project (the host's agent writes it and
corrects it from the build log, up to three times; without an agent a
template covers Rust, Go, CMake, Meson, autotools and release binaries) —
and uploads the package, the PKGBUILD, `PKGINFO` and the build
log to `staging/<you>/<package>/<task>/`. The task is then **staged**: the
Review page lists it, the log and the PKGBUILD are public, the package is
for maintainers. Nothing you build reaches users: a maintainer reads it
on the [Review](../../../../review) page and has the
project build it again — the project's agent, a worker the project
trusts, its own recipe written with your PKGBUILD, log, gate and audit as
the lesson — then approves *that* build into `edge` as source `factory`,
signed by the pool. Your build was the evidence, the project's build is
the product. A rejection comes with a note you see on your Contribute
page.

What a build can and cannot do, learned from the first contributor's day
(2026-09-15): a failed build is **not retried** — the next fresh container
would fail the same way — so fix the PKGBUILD and press *Build* again (the
pool retries only what the infrastructure broke: a download, a mirror, a
container killed under the build). A dependency that is itself a factory
package (pinta needs dotnet) is available to your build only once *that*
package was approved and published into `edge`; until then pacman says
*target not found*. A project with no release or tag is not built — the
factory packages releases (a `-git` package has nothing to pin). A split
PKGBUILD (`pkgname=(a b c)`) builds; only the base's `depends`,
`makedepends` and `checkdepends` are installed, as `makepkg --syncdeps`
would.

Limits: 10 tasks queued or building and 5 GB of staging per contributor
(a single PUT and a multipart upload honour the same cap). The pool gives
the space back itself: the packages of a build it is done with —
superseded by a newer one, rejected, failed for good, published — are
reclaimed at once, the recipe and the log stay; everything expires after
30 days. Drop a build early with `DELETE /api/v1/factory/tasks/<id>/artifacts`
(refused while queued or leased, or while the project builds from it; a staged
build is cancelled). *Remove* on your page takes the registration and
every build of the name — queued, running, or staged and waiting for a
maintainer — with the audits and trials queued for them: the packages
leave staging, what a finished build had put on the record (the recipe,
the log, the reports) stays, a build still running is cut off and leaves
nothing, and anyone can register the name again. A worker fails your task at claim time when your
workspace is full, and reports an upload the pool refused as the build's
failure — the reason is on the build's page. Registering again replaces your
contributor token. `cosign verify ghcr.io/firemanxbr/omarchy-worker:latest
--certificate-identity https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main
--certificate-oidc-issuer https://token.actions.githubusercontent.com` checks
the image is the project's: signed by `release.yml` on `main`, and by nothing
else (after a rollback, by `rollback.yml@refs/heads/main`: the same command
with that file).

Who approves, and how one becomes a maintainer, is
[Governance](../docs/GOVERNANCE.md): a file in this repository,
`factory/MAINTAINERS.toml`, changed by pull requests other maintainers review.

## Sizing a package before committing to it

A **dry run** builds and measures but never publishes or renders: a
maintainer queues it with `publish:false` — by hand, the only build a
maintainer queues (#284: `publish` true or left out is refused,
`dry_run_only`) —
`curl -X POST $API/factory/enqueue -H "authorization: Bearer omc_…" -d '{"name":"chromium","pkgbuild_ref":"<commit>","version":"…","arches":["aarch64"],"reason":"sizing","publish":false,"override":true}'`
(`override` when an upstream source ships the name). The worker keeps the
packages under its work directory (`dry-run/task-<id>`) and the pool never
receives them: the dry run's job token has no pool and no ring scope. The
build's page (`/build/<id>`) shows how long it took and what it measured,
and `GET /api/v1/factory` lists its task with `publish` 0. A dry run is
never the build of its version: `GET /factory/built` leaves it out, so
the enqueue job still queues the build that publishes a recipe on `main`. `factory/sizing/` holds recipes kept
only for this (chromium, from Arch Linux ARM): the only recipes left in
the repository, and the `enqueue` job never queues them.

## Run a worker

**Maintainers only.** Contributors do not run workers: the project provides
the workers for everyone, and its maintainers are their only providers — a
maintainer is vetted by a pull request to `factory/MAINTAINERS.toml`, and
their host is trusted by that same act. `POST /factory/workers` refuses
anyone else (403, *your packages build on the pool's hosts*), and the
worker form is on a maintainer's page only. What follows is for a
maintainer's host.

Anything with `podman` or `docker` and `curl` is a project worker: a
laptop, a VM, a Droplet. **Every task builds in a fresh Arch container**
(`archlinux:base-devel` for x86_64, `menci/archlinuxarm:base-devel` for
aarch64; on a host the agent runs, by the digest the release pinned: see
[the security model](/docs/security-model)) that sees the PKGBUILD and the network and nothing else; the worker
process on the host holds only its own token, publishes the result and the
pool signs it — no key ever sits on a worker. A host builds its own
architecture natively and the other one emulated (`--arch`).

The easiest way is the same container image every worker runs,
`ghcr.io/firemanxbr/omarchy-worker` (both architectures, signed, tagged with
the pool's release; `factory/image/Containerfile`): given a token whose
registration a maintainer trusted, it runs `pkg-repo work` and starts each
build as a sibling container through the runtime's socket — the dashboard's
*Run a worker* page has the exact commands for Docker Desktop and Podman.
Without a container, the release binaries do the same:

```bash
# once: the pool's publisher (from the releases, or cargo build --release -p pkg-repo)
export OMARCHY_API=https://pkgs.omarchy-pool.org OMARCHY_POOL=https://pool.omarchy-pool.org

# register (POST /factory/workers with your maintainer token) and have a
# second maintainer trust it; then, native architecture:
pkg-repo work --worker-token omw_… --labels '{"where":"laptop"}'
# the other one, emulated (Apple silicon builds x86_64 through podman machine)
pkg-repo work --worker-token omw_… --arch x86_64 --labels '{"where":"laptop","emulated":true}'
```

An emulated worker says so in its labels (`"emulated":true`; `--labels`,
or `WORKER_LABELS` when the flag is not given). Its build containers get
the same labels. A build that dies of emulation there is the worker's
failure, not the recipe's: a toolchain that cannot start, or a library
qemu cannot map (*failed to map segment from shared object*: rustc, sudo,
anything linking libedit or libldap). The build script stops at the first
attempt with exit 96, before any drafter turn. `pkg-repo work` and the
community worker report it with `needs_native`, and the build goes back to
the queue for a native worker of its architecture, the attempt given back.
No emulated worker takes it again. Every page that follows the build says
what it waits for.

`--idle-exit 300` makes a worker exit after five minutes without work;
`--once` makes it one-shot; SIGTERM (`docker stop`) drains it — the task in
hand runs to its end and is reported, nothing new is claimed, exit 0 — so
a container can be replaced without losing work. A build container gets `[omarchy-packages-edge]`
and `[omarchy-factory-edge]` in its `pacman.conf` — each one when the pool
serves that database for the architecture — so a package can depend on the
OPR or on an earlier factory build. `OMARCHY_PKG_CACHE=/path` on the host shares one
pacman package cache (a directory per architecture) with every build
container it starts, so a dependency downloads once; `OMARCHY_BUILD_CACHE`
likewise mounts a build cache at `/build/cache` — cargo's registry, Go's
module and build caches, ccache's objects — so a Rust or Go package
rebuilds in minutes. A build container runs make, ninja and cargo with
the job count its dispatcher set to match the task's CPUs (`MAKEFLAGS`,
`NINJAFLAGS`, `CARGO_BUILD_JOBS`), or with every core it sees when none was
set, with ccache on.

**Three roles.** The project runs its workers as three kinds of container
of that same image, `OMARCHY_WORKER_ROLE` set (`factory/image/entrypoint.sh`;
the dashboard's *Run a worker* page, *The three roles*): **pool** — a
project-trusted registration that takes only the pool's jobs (sync, render,
promote, rollback, health, security, enqueue, gc, verify); **review** — a
project-trusted registration that takes only the maintainers' work — the
project's own build of a reviewed package, the build of the recipes on
`main` and the audit of staged builds — reaching the agent through
`agent-proxy`; **community** — a community registration, shared, that builds
anyone's registered packages and drafts PKGBUILDs for package requests, as a
**broker** (the token, the agent key, `GITHUB_TOKEN`; runs no build) beside
a **builder** born with nothing; **broker** itself is a role
(`OMARCHY_WORKER_ROLE=broker`, `agent` without a worker token). A role
narrows what the trust allows and the container refuses a registration that
does not match; project trust takes two maintainers' word. Two of each,
one per architecture, plus the brokers, run on the project's own host
(`factory/host/`, RUNBOOK *The Studio host*).

**Whose compute.** The project's compute is its maintainers' hosts.
Contributors do not run workers: they submit packages, and every build —
a contributor's evidence and the project's own build written from it —
runs on a host a maintainer provides. The community workers registered
before #331 are expected to be the maintainers' own (checked on #331) and
retire with the move to the host agent (#307). No GitHub runner ever builds a package: the project's compute is
not for building everyone's software, and GitHub Actions runs CI and the
release only — no worker, not even for the pool's own jobs: when the
project's host is down they wait, and the Workers page says so.

## The contract

The factory touches the pool through four things, all versioned in the API:

| The factory uses | Meaning |
|---|---|
| `GET /api/v1/package/:name` | who ships a name already (the guard) |
| `POST /api/v1/factory/{requests,enqueue}` · `/requests/:id/{approve,reject}` · `/tasks/:id/cancel` (a maintainer's token — by hand, a dry run only (#284) — or the enqueue job's) · `/tasks/:id/{build,approve,reject}` (a maintainer, never the owner) · `POST /factory/workers` (a maintainer's token; 403 for anyone else, #331) · `/{contributors,packages}/:x/{block,unblock}` (a maintainer — a block, like an approval, in the browser with their passkey; lifting by another) · `POST /factory/jobs` (a maintainer queues a pool job; one that forces a promotion past its evidence in the browser with their passkey, #284) · `GET /factory/built`, `/factory/maintainers`, `/factory/review`, `/factory/blocks` | maintainers and the enqueue job |
| `POST /api/v1/factory/claim` (a registered worker's token) · `/tasks/:id/{heartbeat,complete,fail}` (the claim's job token) | the worker protocol |
| `POST /api/v1/factory/register` · `/factory/packages[/:name/build]` · `PUT /factory/tasks/:id/artifacts/:file` (worker token) · `GET /factory/packages`, `/factory/me` | contributors: registry, staging uploads |
| `pkg-repo publish --source factory --ring edge --arch …` · `pkg-repo render` | how a result enters the pool: as a source like any other |

Nothing in the pool knows how a package is built, where a worker runs or what a
PKGBUILD looks like; nothing in the factory knows how rings, rendering or
promotion work. Moving the factory to its own repository means moving
`factory/`, the `worker-image` jobs of `release.yml` and the issue form, and
pointing the repository name in the worker script, `reconcile.rs`,
`governance.ts` and `requests.ts` at the new home; the pool keeps
`worker/src/routes/factory.ts` (the queue) and the `factory` source.

### Worker protocol

```
POST /factory/claim                 {arch, hostname?, labels?, version?, kinds?, shared?, log?}   Authorization: Bearer omw_… (the registration)
                                    shared: the first word only — once the mode was set from the brain the registration's mode counts:
                                    POST /factory/workers/self/mode {mode} with this token, or POST /factory/workers/:id/mode with a
                                    contributor token (the owner; a maintainer may set dedicated, never shared — sharing is the owner's word);
                                    log: the worker's own lines since its last claim (4 KB a chunk, the last 8 KB kept), for its owner and
                                    the maintainers: GET /factory/workers/:id/log with a contributor token or the dashboard's session
  200 {task:{id,name,arch,version,pkgbuild_ref,reason,attempts,…}, token: "omj.…", token_expires_at, lease_minutes, repo, pkgbuild_path, upload}
  204 nothing queued for this worker
  426 {error, latest, yours, behind, update}   `version` (the image's release) is behind the pool's past the grace — every
                                               worker follows the latest image: update it and claim again (the worker sleeps 5 min)
POST /factory/tasks/:id/heartbeat                                 (the job token) → lease extended 30 min, a fresh token
POST /factory/tasks/:id/complete    {sha256, filename, version?, duration_ms?, log_tail?} · jobs: {result, summary}
  409 unless the sha256 is in the pool (project) or in staging (community)
POST /factory/tasks/:id/fail        {error, duration_ms?, log_tail?}
  → {status:"queued"} while attempts < max_attempts, else {status:"failed"}
PUT  /factory/tasks/:id/artifacts/:name                           (the job token) the evidence and the packages, one body up to 90 MB
POST /factory/tasks/:id/artifacts/:name/multipart?action=create · part&part=N&upload_id= · complete · abort
                                                                   a package above 90 MB, in 64 MB parts — the edge refuses a single body
                                                                   above 100 MB before the pool sees it; both workers upload this way,
                                                                   the project's review build included (bitwarden, 144 MB, 2026-09-17)
```

A claim is one `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`; D1
serialises writes, so two workers never receive the same task. Only the lease
owner can heartbeat, complete or fail it (409 otherwise). The scheduler's cron
requeues leases past `lease_expires_at` — the way out for a worker that
vanished, not the way a worker reports: the community worker's shell has
last words, and whatever ends it while it holds a task (a command that fails
outside the build's subshell, under `set -e`) is posted to `/fail` at once
with the command and its status, the build's log with it. One job at a
time on a ring: a promotion into it, a rollback, a render and the security
fast-track (any ring) are not handed out while another of them holds a
lease on the same ring — a promotion into rc and a fast-track into rc ran
in the same minute and the fast-track's late rollback undid the promotion
(2026-09-17). Syncs and the read-only checks are not held.

## Layout

```
factory/
  README.md                       this file
  worker/omarchy-build-worker.sh  the build half: `--inside` (called by pkg-repo work in a fresh container),
                                  `--container` (the contributor's one-task-per-container mode)
  MAINTAINERS.toml                the governance file: the maintainers, one list (docs/GOVERNANCE.md)
  bin/check-governance            validates it and generates .github/CODEOWNERS from it
  image/Containerfile             the one worker image (Arch, both architectures, signed, built by the release workflow); image/entrypoint.sh
                                  reads the registration and runs the contributor's or the project's half, or the updater; image/compose.yml
                                  runs the set — broker, builder, updater (or a project worker) — as `omarchy-worker start` writes it
  bin/omarchy-rollout             the updater: the compose set follows the pool's latest image, what changed replaced together, itself last
  bin/pkgbuild-meta               PKGBUILD → arches and version, without executing it as you
  sizing/<name>/                  recipes kept for dry runs only (never queued) — the only recipes in the repository
  sizing/tasks.toml               maintainer-set task sizes, disk budgets and network exceptions per package (empty until P2 of #307)
  sets/host/                      the host agent's set (#307): compose.yml with the one dispatcher service, set.toml, files/
  host/prep-root.sh               the root-only steps a new maintainer host needs once (never run by the agent)
  bin/agent.py                    the owner's agent, whichever provider: Anthropic, OpenAI, Gemini, xAI (by the key set)
  bin/draft-pkgbuild              project URL → PKGBUILD (the agent, or a template), checksums left to updpkgsums
  prompts/pkgbuild.md             the packaging rules the drafter follows
  bin/audit-pkgbuild              the second agent: staged PKGBUILD + log + .PKGINFO → audit.json / audit.md
  prompts/audit.md                what the auditor looks for, and the report's shape
.github/CODEOWNERS                      every maintainer owns the governance file, the sizing recipes, the workflows, the host agent, the dispatcher and the host sets
```
