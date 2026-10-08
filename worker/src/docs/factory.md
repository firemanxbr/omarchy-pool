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
   in the queue: the next host of the architecture with room takes it, on
   the pool's hosts, with its agent. The four things, as the form asks them:
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
   setup-token`; the dashboard's *Run a host* page has the steps) — the
   host owner's key, in the task's own agent sidecar, never the pool's; without one a template covers Rust,
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
   host whose agent answers reads the PKGBUILD, the log
   and the `.PKGINFO`, asks the model for a structured review
   (`factory/bin/audit-pkgbuild`, `factory/prompts/audit.md`) and attaches
   `audit.json` / `audit.md` to the evidence. The Review page shows the
   verdict (`ok`, `warn`, `block`); nothing acts on it, the maintainer does.
6. **A maintainer claims it — never their own package** (but the one
   maintainer the governance file's solo-maintainer exception names while it
   is in force, on their own packages, each decision marked self-reviewed:
   #394, [/docs/governance#solo](/docs/governance#solo)). On the Review
   page, a maintainer (`factory/MAINTAINERS.toml`) claims a package that is
   ready (*Build by the project* on a build's page is the same door): the
   project builds it again on a maintainer's host, with the agent the
   maintainer chose — the host registration the claim pins, whose agent
   drafts the rebuild. The workspace puts the factory's build
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
   one again. A host of each architecture takes its task (`review:<task>`),
   in a fresh task container with its own agent sidecar: the project's
   agent gets the request and the contributor's PKGBUILD, log, gate and
   audit as the lesson — `draft-pkgbuild --evidence` — and writes the
   project's own recipe from the project's sources; the same gate runs;
   the packages, the recipe, the log, the gate go to the project's staging
   space (`staging/@project/…`) and the evidence to the record; its own
   audit is queued — and its **trial**: a host with a lane of that
   architecture takes it; its dispatcher puts the package into the pool
   under the factory's directory and pins it into the **lab** (the fourth
   ring: nothing there is promised or promoted), renders the lab, and a real
   pacman in the task's clean container installs it from the lab above
   `edge` (`tests/trial.sh`): dependencies from `edge`, hooks run, files
   verified. The transcript goes beside the
   evidence (`trial.log`); the Review page shows *installs* or what stopped
   it. Nothing is published yet.
7. **A maintainer approves the project's build.** With the project's
   evidence in front of them (the workspace shows the factory's build and the
   rebuild side by side), a maintainer — not the owner — approves, after a
   confirmation, with their passkey in the browser (#271: no token approves
   or blocks). Every decision is a record the pool signs and a journal line
   with who, the door (`via`: the web or a token) and the agent that rebuilt
   each architecture (what the host that rebuilt it ran when it staged it).
   Review's decisions — a claim, approve, request changes, reject, a release, an
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
   `publish` job per architecture: a host's dispatcher fetches the staged
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
   (`bump:<task>@<tag>`) — into the queue at once, as a request's build
   (#343) — and a maintainer reviews it like the first time.
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
builds each supported architecture again on its maintainers' hosts — never an
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
#       "build":{"tasks":[57],"queue":{"aarch64":{"position":2,"total":3}},…}}   — queued at once, in the queue

# 3. Build it again, after a failure or a fix (the request above is already in the queue).
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

## The project's hosts

**Maintainers only.** Contributors do not run workers: the project provides
the workers for everyone, and its maintainers are their only providers — a
maintainer is vetted by a pull request to `factory/MAINTAINERS.toml`, and
their host is trusted by that same act. `POST /factory/workers` refuses a
contributor (403, *your packages build on the pool's hosts*) and, since the
legacy registrations from before hosts retired (#346), answers a maintainer
410 with the pointer to the maintainer-host docs: a machine joins the pool
as a host, enrolled from its owner's page ([a maintainer's host](/docs/worker-host#maintainer-hosts);
the dashboard's *Run a host* page).

**Whose compute.** The project's compute is its maintainers' hosts.
Contributors do not run workers: they submit packages, and every build — a
contributor's evidence and the project's own build written from it — runs
on a host a maintainer provides, and every host builds every contributor's
packages, in turn by owner. The community tier ended with its modes, the
command that ran one and per-worker trust (#343), and the maintainers'
legacy sets from before hosts retired (#346). No GitHub runner
ever builds a package: the project's compute is not for building everyone's
software, and GitHub Actions runs CI and the release only — not even the
pool's own jobs: when no host takes them they wait, and Status says so.

**Three roles, no fixed container.** A host runs one bundle — the host
agent and one service, the **dispatcher** (`pkg-repo dispatch`, the host set
`factory/sets/host/`) — and no container per kind of work: the pool's jobs,
contributors' builds, the project's rebuilds, trials and audits are all
tasks a host claims by its capacity. The one image
(`ghcr.io/firemanxbr/omarchy-worker`, both architectures, signed, tagged with
the pool's release; `factory/image/Containerfile`) has three roles, set with
`OMARCHY_WORKER_ROLE` by the bundle and the dispatcher
(`factory/image/entrypoint.sh`): **dispatcher** — the host's one service,
which holds the host's worker token in a read-only file and each lease's job
token, claims, stages a task's inputs, starts it, uploads what its kind may
upload after it exits, and runs the pool's jobs in child processes of its
own; **egress** — one per task, the task's only way out, to public
addresses; **agent** — one per task that needs a model, its agent sidecar
(`factory/bin/broker`), which holds the host owner's agent keys read-only
and serves that one task within its caps. The task itself runs in a
container started from the build image by digest (`archlinux:base-devel`
for x86_64, `menci/archlinuxarm:base-devel` for aarch64), born with nothing:
no token, no key, no socket, on an internal network of its own, the build
script (`factory/worker/omarchy-build-worker.sh --task`) reading what was
staged in `/task/in` and writing to `/task/out`. Nothing in it calls the
pool, and the pool signs what is published (design v2 §9;
[the security model](/docs/security-model#isolation)).

**Capacity and lanes.** The agent detects what the machine has and counts
it in units (design v2 §7.3): a build takes 2 per size (`factory/sizing/tasks.toml`
sets a package's size, and the pool learns it from its builds, #330), a trial
2, an audit 1, and one unit stays for the pool's jobs; the owner's envelope
(`agent.toml`, at the host) caps what the machine gives and the pool cap
lowers what the pool hands it. The pool gives a host as many leases as its
free units hold, one per claim; whatever does not fit waits in the pool's
queue, never on a host. A host's **lanes** are its agent's
(`run/capacity.json`, #338): its own architecture natively, and the other one
**emulated** when the kernel has qemu's binfmt handler with the `F` flag
(`factory/host/prep-root.sh` installs it) and the release's build image of
that architecture starts there; a Mac's x86_64 lane is Rosetta's in its VM.
Selection is native first (#337, design v2 §8.3): a build of an architecture
a host runs emulated waits a little for a native host (twice that
package's last native build, 3 to 60 minutes) unless none could take it
now, and emulated lanes are always given a share — while no host runs an
architecture natively, each host that can keeps one of its builds moving —
so slower is accepted and nothing is left out.

**Emulation is part of scaling.** Adding hosts is how the pool grows, and
every host adds to both architectures: natively to its own, emulated to the
other. An emulated build is slower and shares the host's units; a build
that dies of emulation (a toolchain that cannot start, or a library qemu
cannot map — *failed to map segment from shared object*: rustc, sudo,
anything linking libedit or libldap — on a 16K-page kernel) is the lane's
failure, not the recipe's: the build script stops at the first attempt with
exit 96, before any drafter turn, and reports `needs_native`, which the pool
takes only from a lease it put on an emulated lane — the attempt given back,
the build back in the queue — and refuses from a native lane (a failure like
any other). That is D33, amended by #413: `needs_native` means *needs 4K
pages or a native host*. What 16K pages cannot map (the Studio's Asahi
kernel), qemu maps on a 4K-page kernel, so an emulated lane whose host
reports `page16k: false` — the Studio's x86_64 VM (the runbook's *The
Studio's x86_64 VM*), a Mac's Rosetta VM — takes the build too; no other
emulated lane takes it again. The pool marks it `refused_4k` too when the
host's lanes say 4K pages or the build already carried `needs_native` (only
a lane its claim says is on 4K pages is handed such a build, so its second
time back is always its last): only a native host takes it then, and
emulation has given its attempt back twice at most. Every page that follows
the build says what it waits for, and the Workers page and Status say which
architecture needs a native host next.

**Inside a task.** A build container gets `[omarchy-packages-edge]` and
`[omarchy-factory-edge]` in its `pacman.conf` — each one when the pool
serves that database for the architecture — so a package can depend on the
OPR or on an earlier factory build. The host shares one pacman package
cache per architecture with every task, read-only, and keeps a build cache
per package (#341) — cargo's registry, Go's module and build caches,
ccache's objects at `/build/cache` — so a Rust or Go package rebuilds in
minutes, and a build reads only what an earlier build of the same package,
on the same side, wrote. A build container runs make, ninja and cargo with
the job count the dispatcher set to match the task's CPUs (`MAKEFLAGS`,
`NINJAFLAGS`, `CARGO_BUILD_JOBS`), with ccache on.

## The contract

The factory touches the pool through four things, all versioned in the API:

| The factory uses | Meaning |
|---|---|
| `GET /api/v1/package/:name` | who ships a name already (the guard) |
| `POST /api/v1/factory/{requests,enqueue}` · `/requests/:id/{approve,reject}` · `/tasks/:id/cancel` (a maintainer's token — by hand, a dry run only (#284) — or the enqueue job's) · `/tasks/:id/{build,approve,reject}` (a maintainer, never the owner — but the one maintainer the solo-maintainer exception names, on their own package, self-reviewed, #394) · `/{contributors,packages}/:x/{block,unblock}` (a maintainer — a block, like an approval, in the browser with their passkey; lifting by another) · `POST /factory/jobs` (a maintainer queues a pool job; one that forces a promotion past its evidence in the browser with their passkey, #284) · `GET /factory/built`, `/factory/maintainers`, `/factory/review`, `/factory/blocks` | maintainers and the enqueue job |
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
POST /factory/claim                 {arch, hostname?, labels?, version?, kinds?, log?}   Authorization: Bearer omw_… (the registration)
                                    log: the worker's own lines since its last claim (4 KB a chunk, the last 8 KB kept), for its owner and
                                    the maintainers: GET /factory/workers/:id/log with a contributor token or the dashboard's session
  200 {task:{id,name,arch,version,pkgbuild_ref,reason,attempts,…}, token: "omj.…", token_expires_at, lease_minutes, repo, pkgbuild_path, upload}
  204 nothing queued for this worker
  426 {error, latest, yours, behind, update}   `version` (the image's release) is behind the pool's past the grace — every
                                               worker follows the latest image: update it and claim again (the worker sleeps 5 min);
                                               `revoked: true` when that release is one the pool's release revokes, whatever the grace (#342)
POST /factory/tasks/:id/heartbeat                                 (the job token) → lease extended 30 min, a fresh token
POST /factory/tasks/:id/complete    {sha256, filename, version?, duration_ms?, log_tail?} · jobs: {result, summary}
  409 unless the sha256 is in the pool (project) or in staging (community)
POST /factory/tasks/:id/fail        {error, duration_ms?, log_tail?}
  → {status:"queued"} while attempts < max_attempts, else {status:"failed"}
  every lease keeps the release it was claimed on (`build_tasks.release`, the claim's `version`); once the pool's release
  revokes it (#342), its heartbeat, uploads, pool and ring writes and completion get 409 {stop: true, state: "revoked"},
  and its fail, whatever it says, → {status:"queued", revoked} with the attempt given back
PUT  /factory/tasks/:id/artifacts/:name                           (the job token) the evidence and the packages, one body up to 90 MB
POST /factory/tasks/:id/artifacts/:name/multipart?action=create · part&part=N&upload_id= · complete · abort
                                                                   a package above 90 MB, in 64 MB parts — the edge refuses a single body
                                                                   above 100 MB before the pool sees it; both workers upload this way,
                                                                   the project's review build included (bitwarden, 144 MB, 2026-09-17)
```

A maintainer host's registration (#321, `kind = host`) claims as its dispatcher (#334, design v2 §8.1).
Past the grace it is refused with `426` like any worker, but for one exception (#342, D55): while its
host's reports say its agent reverted the pool's own release, it claims on the release its agent
applied — its last-good — for six hours after the pool first heard of the revert, never below the
signed `min_release` nor on a revoked release, with a warning on Status (the listing's
`update.last_good_until`) and its host's page (*A host reverted a release* in the runbook). A
soaking host's registration (#326) is kept out of the gate until its soak ends, at most two hours
after the deploy; neither the soak nor the last-good holds a revoked release, and where both would
hold, the host claims on its last-good (`worker/src/update.ts` `updateState`).

```
POST /factory/claim   {arch, version, hostname, kinds, agent: {provider, model, probe}, usage?,
                       claim_id,            c_…, new per attempt: a retry after a lost answer reuses it and gets the same lease, a fresh token
                       want,                1 to take a task, 0 to reconcile and take orders only (every 30 s while it is full)
                       capacity,            {cpus, mem_gb, disk_free_gb: {work, engine}, units, job_reserved, agent_slots, lanes} (required with want 1)
                       offer?,              the units this claim offers when MemAvailable holds fewer than its free units (#337): no task
                                            above it this round; the host is still counted by its capacity (its builds, the largest size)
                       leases}              [{task, gen}]: every lease the dispatcher holds
  400 a field missing or malformed: nothing is guessed
```

Each lease has a random generation (`build_tasks.lease_gen`, `g_<16 hex>`), carried in its job token
(`g`): a heartbeat, a report or an upload is taken only from the token of that very lease (never
the host's worker token), and so are its pool and ring writes (`pool:write`, `release:<ring>`,
`artifacts:…`: only while that lease is held and not stopped), so a token of an earlier lease of
the same task on the same host is refused (409, `stop: true`). The pool compares `leases` with
its own: an unfenced lease two consecutive claims did not list goes back to the queue once it is
2 minutes old, its attempt given back while the task's `host_losses` allow (it counts as a
`lost`; past two the attempt is spent); a fenced one (a Stop) ends
when a claim no longer lists it, or at the lease's end. It leases only what fits, from its own
leases: their units plus the task's within min(declared units, units recomputed from the totals
with the signed constants, the pool's cap), one unit kept for pool jobs, model work within
`agent_slots`, a build's disk budget within both free-disk values less the floor and the budgets
of the builds it holds — as many leases at once as that allows (#337). A host takes builds of
every trust, trials and audits, and — once the `host-pool-jobs` setting names it (#340) — the pool
jobs: the arch-neutral ones whatever their row's arch, a health check or a promotion only with a
lane of each arch its helpers check; which one comes next is the selection's (below). A Stop is per lease (`task` names it; several open at once, 30 an hour per
login), and `fail` takes `lost: true` (a host event: the attempt given back, twice per task at
most) and `oom: true` (the engine's kill: the attempt spent, the reason kept). A build's `oom`
raises the size its package remembers one step (to 2 at most for a contributor's build and the
project's copy of it, 4 for the project's recipe on main), and a build's `complete` carries
`ram_anon_peak_mb`, what its container held that reclaim cannot free (never the page cache), five
of which in a row below what the size under the remembered one gives lower it one step (#330, D31;
the runbook's *Sizes*).

On the host, the dispatcher (`pkg-repo dispatch`, #335, design v2 §9) holds those leases and runs
each in one task container it starts through one function (`crates/pkg-repo/src/dispatch/spec.rs`):

```
start      refuses a signing key, an agent key or a GitHub token in its environment; re-adopts: a task container with a lease file
           (work/state/leases/<id>-<gen>.json, 0600) runs on or, exited, is completed from its exit code,
           OOMKilled and outputs; one without goes; a lease whose container is gone fails `lost`; then /ready
loop       per lease: a release in this host's merged revoked set (#342: the signed manifest built in, with every
           list a dispatcher of this host kept in work/state/revoked.json) or the heartbeat's 409 state "revoked":
           kill in whatever phase, fail {revoked, lost}; a task of any other release runs on to its end;
           heartbeat (409 stop: kill, fail as stopped), its own watchdog (last accepted heartbeat
           + 35 min: kill, report nothing), its container's state; the disk watcher (work root below the
           floor: the youngest build killed `lost`, want 0 until the space is back; a build refused at start
           for its budget: builds left out of the claims, trials and audits not, until it fits, 30 min at most);
           then the claim: want 1 while units are free beside its leases and the job unit, offering only what
           MemAvailable still holds below the largest task it could receive (#337; the shares of the leases it
           started in the last 5 minutes subtracted: their containers have not grown yet) — and while the job
           unit is free, the pool's kinds listed with its own (#340) — again at the next tick after a task,
           every 30 s otherwise; want 0 every 30 s when full, the job unit too, or when fewer units than leases
           remain (nothing running is killed); each lease starts at once in its own container, no host queue
jobs       a pool job (#340): one at a time, in a child process of its own (pkg-repo pool-job: a 2 GB data rlimit, its
           job token in <task dir>/token, renewed at each heartbeat, its result in result.json; work dir <work root>/jobs,
           its scripts' TMPDIR <task dir>/tmp), killed with its process group and its helpers past its kind's timeout
           (render, rollback, enqueue 30 min; health 45; gc, publish 60; sync, security 150; promote 180; verify,
           relayout 240) and failed; a job running when the dispatcher is replaced fails `lost`; its scripts' only
           engine omarchy-task-run (RUNTIME, and docker and podman first on its PATH): `run --rm --platform …
           [-e KEYRING=…] -v <scratch dir>:/repo[:ro] <an image tests/images.env pins> bash /repo/<script>.sh` as a
           helper <network>-helper on the job's own internal network beside its egress sidecar, made as a task's
           and never a sizing exception's bridge, whatever OMARCHY_DIRECT_NETWORK grants (health, promote,
           security and enqueue — its PKGBUILD reader, on the host's native arch — get a /28), anything else
           refused (125); the job holds the unit kept for pool jobs, never a task's (a build starts beside it)
in         /task/in (read-only): meta.sh, the evidence a recipe learns from, an audit's staged build, a trial's check
out        /task/out: the kind's closed list under its caps (a build: packages, PKGBUILD, vet.json, tests.log,
           resources.json, verdict.json), uploaded by the dispatcher with the job token — a build's completion
           says the ram_anon_peak_mb its resources.json measured (what it held that reclaim cannot free, sampled
           from its cgroup's memory.stat; never ram_peak_mb, the high-water mark page cache fills), none when it
           says 0 or does not read (#330);
           /task/log/task.log, ≤ 64 MiB
           (the engine keeps no log of a task container); exited with no verdict.json, or a verdict of a
           SIGTERM or SIGKILL, fails `lost` (a reboot, a shutdown): the attempt is given back
exit 75    a restart order, or a loop without progress for 15 min: task containers run on, the next dispatcher re-adopts them
network    per lease (#336): an --internal network omarchy-task-<id>-<gen> on a /28 of OMARCHY_TASK_SUBNETS, with no
           gateway (docker ≥ 28: gateway_mode_ipv4=isolated; podman: DNS off, by its own CLI's --disable-dns or,
           behind docker's CLI, through libpod's API on the socket that CLI talks to, #372; install's preflight
           refuses a host where a task reaches a network's gateway, #367); its egress
           sidecar <network>-egress (pkg-repo egress: CONNECT, GET, HEAD to public addresses only, judged by the
           resolved address) on the shared omarchy-egress bridge and on the task's network, the task's HTTP(S)_PROXY;
           a model kind's agent sidecar <network>-agent (the broker, agent.env read-only, its caps in BROKER_AGENT_*,
           its usage in <task dir>/agent; run as agent.env's owner as the engine shows it, OMARCHY_AGENT_USER, never
           out of the engine's user namespace: on a remapped daemon OMARCHY_AGENT_HELD instead, no agent sidecar and no
           probe, #399); all removed with the lease, orphans of this host swept at start and
           before each /28 is chosen;
           factory/sizing network = "direct" (with a reason): a bridge network of its own, no egress — on a
           host whose envelope grants it (OMARCHY_DIRECT_NETWORK, #373); elsewhere handed back lost (the attempt
           given back for a task's first HOST_LOSSES_MAX losses, spent after: the claim does not say yet whether
           a host runs such packages)
caches     per lease (#341, D52): <work>/cache/pacman/<arch> read-only at /var/cache/pacman/shared (a build's and an
           audit's pacman's first CacheDir; a trial's check reads none), and <task dir>/pkgcache writable at
           /var/cache/pacman/pkg, where it downloads; a build also its own package's
           <work>/cache/build/<trust>/<arch>/<package> at /build/cache — never the tree, another package's or the other
           side's; after the lease its downloads go into the shared cache only when each file's SHA-256 is the one the
           pool's signed edge databases of that arch list (every source's, fetched hourly, each .sig verified with the
           pool's key built into the dispatcher; a name two databases list with different bytes is never merged), each
           package with the pool's own copy of its upstream .sig beside it (<source>/<arch>/<file>.sig: a build's
           pacman checks the image's Arch sections' packages by the .sig beside the file it found, and fails on one
           without it), which must be the .sig the build downloaded when it downloaded one, or not at all; the rest
           discarded, and each pass removes a file whose name the databases of the day list with other bytes than
           its record's, its .sig after it; the pacman cache keeps two versions per package within OMARCHY_CACHE_PACMAN_GB, the build
           caches go least recently used first within OMARCHY_CACHE_BUILD_GB (the envelope's cache_caps; 10 and 20 GB
           by default), never one a lease mounts
agent      the claim's agent: {provider, model, probe, error, checked_at} from a probe sidecar on a network of its own
           (at start, every 30 min, sooner after a failure, and for recheck-agent / restart-agent); the day's agent
           calls (OMARCHY_AGENT_CALLS_PER_DAY) spent: agent_slots 0 in the claim and no model task starts
```

A claim (#337, design v2 §8.3; `worker/src/selection.ts`) with nothing
queued of its kinds reads nothing more (one probe of the kind index).
Otherwise it reads the registrations alive and every lease the pool holds
first, so it knows the
claimer's room — its free units (and its `offer`), a free agent slot, its
disk, the largest size alive, the contributors at their cap. Then bounded
heads of the queue (`ORDER BY priority, id LIMIT 50`), each filtered in SQL
by that room so a head of tasks it cannot take never hides one it can: one
per arch of its lanes (a long backlog of one arch never hides another's, so
the guaranteed share and native work arriving are always seen), one of the
arch-neutral kinds, each contributor's first community build of each arch
(a walk over the owners through a partial index, so one contributor's
backlog never hides another's package, and a capped contributor's flood
hides no one's), the first native task whatever its size (it holds the
emulated lanes to their share), the task the host reserves for, and the
oldest builds the reservation weighs; then the sizes set for the
candidates' packages (and the sizes learned from their builds, #330) and
their last native build; selection orders the
candidates — priority, then community builds round-robin by owner (within a
per-owner cap, the `owner-cap-divisor` setting), then effective age (the
wait less the lane's penalty: 0 native, T emulated), then id, the
guaranteed emulated share first — and the first is leased with one
`UPDATE … WHERE id = ? AND status = 'queued' RETURNING *` (the next, when
another claim took it first); D1
serialises writes, so two workers never receive the same task. A host's
lease records its `lane`, `size`, `units` and `disk_gb`, and the statement
itself checks the host's units again. A host's lanes are its agent's (`run/capacity.json`, #338): the native one
and each emulated one it detected. Builds and trials run on a lane of their
arch; a job with helper containers needs a lane of each ring architecture
they check (`health` its own, `promote` each it promotes, `security` both),
native or emulated, with no wait; every other kind is arch-neutral. Placement (#339, design v2 §8.4; D35, D36): the project's copy
of a package — its review rebuild — is never handed to a host its requester
owns (the rebuild's owner, and the owner of the contributor's build it
answers) while another maintainer's host has a lane allowed for it, native or
emulated with its marks applied (`needs_native`: a lane on 4K pages only;
`refused_4k`: none), and could hold it idle at its size
(its units within the pool cap, an agent slot, its disk budget against its
free disk plus the budgets of the builds it runs — a report below the
minimum for that disk alone, or a claim holding builds back for disk, is
busy, not gone); when only
the requester's hosts have one, it waits, and Review offers another maintainer *Release to any host* at
once, with their passkey (`POST /factory/tasks/:id/any-host`,
`any-host:<task>`), on the task (`params.any_host`), the journal and the
record — except for the packages of the maintainer the solo-maintainer
exception names (#394): their own hosts take that copy, with no release, and
Review says why. An audit — in a fresh container with its own agent sidecar, by
construction — leaves the machine that built what it audits (its
registration, or one of the same owner's the pool cannot tell apart from it:
two registrations are apart only with different owners — a host is what
enrolled, not a machine, and one owner's two hosts may be one, as the
Studio and the x86_64 VM it runs are, #413) to another that can take it now
(for 3 minutes, so the builder never idles for it); an
audit of the project's copy takes a model (the claim's `agent`: provider and
model) other than the one that built it whenever a registration taking
audits with another model, and that is handed work (not drained, below the
minimum or behind the release), answered in the last 24 hours (its last
claim while its probe passes, the start of its failing spell while it
fails), and runs on the same model otherwise; a claim reads those audits
apart, so a head of them never hides another. Each audit's lease records
`build_tasks.independent` — `model`, `host` (the same model on another
owner's machine, for an audit that does not ship) or `none` — cleared when the
lease goes back to the queue, and Review shows it beside the verdict. A host
whose agent reports `asleep` (#329: a Mac about to sleep, or asleep, while
that report is fresh) has zero free units: its claims are handed nothing
(the lease's own statement checks it again, as it checks a suspension), and
it is no native capacity an emulated lane waits for, neither the other
maintainer's host the project's copy waits for nor another machine an audit
is left to, holds no reservation mark and counts in no size alive until a
report says it woke. The runbook's *How the pool hands a host work* has the
rules. Only the lease
owner can heartbeat, complete or fail it (409 otherwise). The scheduler's cron
requeues leases past `lease_expires_at` — the way out for a host that
vanished, not the way a host reports: the dispatcher reports every task
whose container ended, with its exit code, the engine's out-of-memory word
and its log, and a lease it lost (`lost`, the attempt given back at most
twice, D54); the build script's own last words — a command that fails
outside the build's subshell, under `set -e` — are in `verdict.json`, which
is always JSON. One job at a
time on a ring: a promotion into it, a rollback, a render and the security
fast-track (any ring) are not handed out while another of them holds a
lease on the same ring — a promotion into rc and a fast-track into rc ran
in the same minute and the fast-track's late rollback undid the promotion
(2026-09-17). Syncs and the read-only checks are not held.

## Layout

```
factory/
  README.md                       this file
  worker/omarchy-build-worker.sh  the build half: `--task` (in a task container the dispatcher starts, born with nothing: what was
                                  staged in /task/in, what it makes to /task/out); `--inside` and `--container`, the modes of the legacy
                                  registrations' `pkg-repo work` and community container, kept for whatever of them is not retired yet
  MAINTAINERS.toml                the governance file: the maintainers, one list (docs/GOVERNANCE.md)
  bin/check-governance            validates it and generates .github/CODEOWNERS from it
  image/Containerfile             the one worker image (Arch, both architectures, signed, built by the release workflow); image/entrypoint.sh
                                  starts its role: the dispatcher, a task's egress sidecar, a task's agent sidecar
  bin/broker                      a task's agent sidecar: the agent in the Anthropic Messages shape and GitHub read-only, for one task,
                                  within its caps (no pool path since #346)
  bin/pkgbuild-meta               PKGBUILD → arches and version, without executing it as you
  sizing/<name>/                  recipes kept for dry runs only (never queued) — the only recipes in the repository
  sizing/tasks.toml               maintainer-set task sizes, disk budgets (the pool's claims read them, #337, above the sizes it learns, #330) and network exceptions per package
  sets/host/                      the host agent's set (#307): compose.yml with the one dispatcher service, set.toml, files/
  host/prep-root.sh               the root-only steps a new maintainer host needs once (never run by the agent)
  host/prep-mac.sh                a Mac's once, without sudo: Colima and Lima from Homebrew, the omarchy VM's three directories (#320)
  bin/agent.py                    the owner's agent, whichever provider: Anthropic, OpenAI, Gemini, xAI (by the key set)
  bin/draft-pkgbuild              project URL → PKGBUILD (the agent, or a template), checksums left to updpkgsums
  prompts/pkgbuild.md             the packaging rules the drafter follows
  bin/audit-pkgbuild              the second agent: staged PKGBUILD + log + .PKGINFO → audit.json / audit.md
  prompts/audit.md                what the auditor looks for, and the report's shape
.github/CODEOWNERS                      every maintainer owns the governance file, the sizing recipes, the workflows, the host agent, the dispatcher and the host sets
```
